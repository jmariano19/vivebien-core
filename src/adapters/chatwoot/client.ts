import { config } from '../../config';
import { ChatwootError } from '../../shared/errors';
import { logger } from '../../infra/logging/logger';

interface SendMessageOptions {
  isPrivate?: boolean;
  contentType?: 'input_textarea' | 'cards' | 'input_select';
  contentAttributes?: Record<string, unknown>;
}

export class ChatwootClient {
  private baseUrl: string;
  private apiKey: string;
  private accountId: number;

  constructor() {
    this.baseUrl = config.chatwootUrl;
    this.apiKey = config.chatwootApiKey;
    this.accountId = config.chatwootAccountId;
  }

  /**
   * Send a message to a conversation
   */
  async sendMessage(
    conversationId: number,
    content: string,
    options: SendMessageOptions = {}
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;

    const body: Record<string, unknown> = {
      content,
      message_type: 'outgoing',
      private: options.isPrivate || false,
    };

    if (options.contentType) {
      body.content_type = options.contentType;
    }

    if (options.contentAttributes) {
      body.content_attributes = options.contentAttributes;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': this.apiKey,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ChatwootError(
          `Failed to send message: ${response.status} ${error}`
        );
      }

      logger.debug({ conversationId, contentLength: content.length }, 'Message sent via Chatwoot');
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }

  /**
   * Get conversation details
   */
  async getConversation(conversationId: number): Promise<{
    id: number;
    status: string;
    contact: {
      id: number;
      phone_number: string;
      name: string;
    };
  }> {
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}`;

    try {
      const response = await fetch(url, {
        headers: {
          'api_access_token': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new ChatwootError(`Failed to get conversation: ${response.status}`);
      }

      return await response.json() as {
        id: number;
        status: string;
        contact: {
          id: number;
          phone_number: string;
          name: string;
        };
      };
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }

  /**
   * Find the most recent conversation for a phone number
   * 1. Search contacts by phone → 2. Get contact's conversations
   */
  async findConversationByPhone(phone: string): Promise<number | null> {
    try {
      // Step 1: Search for contact by phone
      const searchUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/search?q=${encodeURIComponent(phone)}`;
      const searchResponse = await fetch(searchUrl, {
        headers: { 'api_access_token': this.apiKey },
      });

      if (!searchResponse.ok) {
        throw new ChatwootError(`Failed to search contacts: ${searchResponse.status}`);
      }

      const searchData = await searchResponse.json() as { payload: { id: number; phone_number: string }[] };
      const contact = searchData.payload?.[0];
      if (!contact) return null;

      // Step 2: Get conversations for this contact
      const convUrl = `${this.baseUrl}/api/v1/accounts/${this.accountId}/contacts/${contact.id}/conversations`;
      const convResponse = await fetch(convUrl, {
        headers: { 'api_access_token': this.apiKey },
      });

      if (!convResponse.ok) {
        throw new ChatwootError(`Failed to get contact conversations: ${convResponse.status}`);
      }

      const convData = await convResponse.json() as { payload: { id: number; status: string }[] };
      return convData.payload?.[0]?.id || null;
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }

  /**
   * Toggle conversation status (open/resolved/pending)
   */
  async updateStatus(
    conversationId: number,
    status: 'open' | 'resolved' | 'pending'
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/toggle_status`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': this.apiKey,
        },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        throw new ChatwootError(`Failed to update status: ${response.status}`);
      }
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }

  /**
   * Add labels to a conversation
   */
  async addLabels(conversationId: number, labels: string[]): Promise<void> {
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/labels`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': this.apiKey,
        },
        body: JSON.stringify({ labels }),
      });

      if (!response.ok) {
        throw new ChatwootError(`Failed to add labels: ${response.status}`);
      }
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }

  /**
   * Send a file attachment to a conversation (for PDFs, images, etc.)
   * Uses multipart/form-data as required by Chatwoot API.
   */
  async sendAttachment(
    conversationId: number,
    fileBuffer: Buffer,
    fileName: string,
    message?: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;

    try {
      // Determine MIME type
      const mimeType = fileName.endsWith('.pdf') ? 'application/pdf'
        : fileName.endsWith('.png') ? 'image/png'
        : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg'
        : 'application/octet-stream';

      // Build multipart form data
      const boundary = `----FormBoundary${Date.now()}`;
      const parts: Buffer[] = [];

      // Message type field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="message_type"\r\n\r\noutgoing\r\n`
      ));

      // Content field (optional caption)
      if (message) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${message}\r\n`
        ));
      }

      // File field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'api_access_token': this.apiKey,
        },
        body,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ChatwootError(`Failed to send attachment: ${response.status} ${error}`);
      }

      logger.debug({ conversationId, fileName }, 'Attachment sent via Chatwoot');
    } catch (error) {
      if (error instanceof ChatwootError) throw error;
      const err = error as Error;
      throw new ChatwootError(`Failed to send attachment: ${err.message}`, err);
    }
  }

  /**
   * Download attachment from Chatwoot
   */
  async downloadAttachment(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url, {
        headers: {
          'api_access_token': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new ChatwootError(`Failed to download attachment: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      if (error instanceof ChatwootError) {
        throw error;
      }
      const err = error as Error;
      throw new ChatwootError(`Network error: ${err.message}`, err);
    }
  }
}
