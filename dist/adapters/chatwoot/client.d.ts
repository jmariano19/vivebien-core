interface SendMessageOptions {
    isPrivate?: boolean;
    contentType?: 'input_textarea' | 'cards' | 'input_select';
    contentAttributes?: Record<string, unknown>;
}
export declare class ChatwootClient {
    private baseUrl;
    private apiKey;
    private accountId;
    constructor();
    /**
     * Send a message to a conversation
     */
    sendMessage(conversationId: number, content: string, options?: SendMessageOptions): Promise<void>;
    /**
     * Get conversation details
     */
    getConversation(conversationId: number): Promise<{
        id: number;
        status: string;
        contact: {
            id: number;
            phone_number: string;
            name: string;
        };
    }>;
    /**
     * Find the most recent conversation for a phone number
     * 1. Search contacts by phone → 2. Get contact's conversations
     */
    findConversationByPhone(phone: string): Promise<number | null>;
    /**
     * Toggle conversation status (open/resolved/pending)
     */
    updateStatus(conversationId: number, status: 'open' | 'resolved' | 'pending'): Promise<void>;
    /**
     * Add labels to a conversation
     */
    addLabels(conversationId: number, labels: string[]): Promise<void>;
    /**
     * Send a file attachment to a conversation (for PDFs, images, etc.)
     * Uses multipart/form-data as required by Chatwoot API.
     */
    sendAttachment(conversationId: number, fileBuffer: Buffer, fileName: string, message?: string): Promise<void>;
    /**
     * Download attachment from Chatwoot
     */
    downloadAttachment(url: string): Promise<Buffer>;
}
export {};
//# sourceMappingURL=client.d.ts.map