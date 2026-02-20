"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatwootClient = void 0;
const config_1 = require("../../config");
const errors_1 = require("../../shared/errors");
const logger_1 = require("../../infra/logging/logger");
class ChatwootClient {
    baseUrl;
    apiKey;
    accountId;
    constructor() {
        this.baseUrl = config_1.config.chatwootUrl;
        this.apiKey = config_1.config.chatwootApiKey;
        this.accountId = config_1.config.chatwootAccountId;
    }
    /**
     * Send a message to a conversation
     */
    async sendMessage(conversationId, content, options = {}) {
        const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
        const body = {
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
                throw new errors_1.ChatwootError(`Failed to send message: ${response.status} ${error}`);
            }
            logger_1.logger.debug({ conversationId, contentLength: content.length }, 'Message sent via Chatwoot');
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
    /**
     * Get conversation details
     */
    async getConversation(conversationId) {
        const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}`;
        try {
            const response = await fetch(url, {
                headers: {
                    'api_access_token': this.apiKey,
                },
            });
            if (!response.ok) {
                throw new errors_1.ChatwootError(`Failed to get conversation: ${response.status}`);
            }
            return await response.json();
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
    /**
     * Search for conversations by phone number or contact query
     */
    async searchConversations(query) {
        const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/filter`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api_access_token': this.apiKey,
                },
                body: JSON.stringify({
                    payload: [
                        {
                            attribute_key: 'phone_number',
                            filter_operator: 'contains',
                            values: [query],
                            query_operator: null,
                        },
                    ],
                }),
            });
            if (!response.ok) {
                throw new errors_1.ChatwootError(`Failed to search conversations: ${response.status}`);
            }
            const data = await response.json();
            return data.data?.payload || [];
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
    /**
     * Toggle conversation status (open/resolved/pending)
     */
    async updateStatus(conversationId, status) {
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
                throw new errors_1.ChatwootError(`Failed to update status: ${response.status}`);
            }
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
    /**
     * Add labels to a conversation
     */
    async addLabels(conversationId, labels) {
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
                throw new errors_1.ChatwootError(`Failed to add labels: ${response.status}`);
            }
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
    /**
     * Send a file attachment to a conversation (for PDFs, images, etc.)
     * Uses multipart/form-data as required by Chatwoot API.
     */
    async sendAttachment(conversationId, fileBuffer, fileName, message) {
        const url = `${this.baseUrl}/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`;
        try {
            // Determine MIME type
            const mimeType = fileName.endsWith('.pdf') ? 'application/pdf'
                : fileName.endsWith('.png') ? 'image/png'
                    : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? 'image/jpeg'
                        : 'application/octet-stream';
            // Build multipart form data
            const boundary = `----FormBoundary${Date.now()}`;
            const parts = [];
            // Message type field
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message_type"\r\n\r\noutgoing\r\n`));
            // Content field (optional caption)
            if (message) {
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${message}\r\n`));
            }
            // File field
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachments[]"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
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
                throw new errors_1.ChatwootError(`Failed to send attachment: ${response.status} ${error}`);
            }
            logger_1.logger.debug({ conversationId, fileName }, 'Attachment sent via Chatwoot');
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError)
                throw error;
            const err = error;
            throw new errors_1.ChatwootError(`Failed to send attachment: ${err.message}`, err);
        }
    }
    /**
     * Download attachment from Chatwoot
     */
    async downloadAttachment(url) {
        try {
            const response = await fetch(url, {
                headers: {
                    'api_access_token': this.apiKey,
                },
            });
            if (!response.ok) {
                throw new errors_1.ChatwootError(`Failed to download attachment: ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
        catch (error) {
            if (error instanceof errors_1.ChatwootError) {
                throw error;
            }
            const err = error;
            throw new errors_1.ChatwootError(`Network error: ${err.message}`, err);
        }
    }
}
exports.ChatwootClient = ChatwootClient;
//# sourceMappingURL=client.js.map