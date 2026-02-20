/**
 * Validation utilities for ViveBien Core
 * Centralized validation logic for better maintainability
 */
/**
 * Validate UUID format
 */
export declare function isValidUUID(value: string): boolean;
/**
 * Validate phone number format
 * Accepts: +1234567890 (10-15 digits after +)
 */
export declare function isValidPhone(phone: string): boolean;
/**
 * Normalize phone number (remove spaces, dashes, parentheses)
 */
export declare function normalizePhone(phone: string): string;
/**
 * Validate language code
 */
export declare function isValidLanguage(lang: string): lang is 'es' | 'en' | 'pt' | 'fr';
/**
 * Validate name format
 * - 1-4 words
 * - Each word 2-20 characters
 * - Only letters (including accented)
 */
export declare function isValidName(name: string): boolean;
/**
 * Sanitize user input for safe storage
 * - Trim whitespace
 * - Remove control characters
 * - Limit length
 */
export declare function sanitizeInput(input: string, maxLength?: number): string;
/**
 * Validate message content
 * - Not empty
 * - Not too long
 * - Contains printable characters
 */
export declare function isValidMessage(message: string): boolean;
/**
 * Validate conversation ID
 */
export declare function isValidConversationId(id: number | string): boolean;
/**
 * Clean and validate summary content
 */
export declare function validateSummaryContent(content: string): {
    valid: boolean;
    cleaned: string;
};
/**
 * Validate webhook payload from Chatwoot
 */
export interface ChatwootWebhookPayload {
    event: string;
    conversation: {
        id: number;
        messages?: Array<{
            id: number;
            content: string;
            message_type: string;
            sender?: {
                type: string;
                phone_number?: string;
            };
            attachments?: Array<{
                file_type: string;
                data_url: string;
            }>;
        }>;
    };
}
export declare function isValidChatwootPayload(payload: unknown): payload is ChatwootWebhookPayload;
//# sourceMappingURL=validation.d.ts.map