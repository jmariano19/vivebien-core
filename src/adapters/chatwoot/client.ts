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

      return await response.json();
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
