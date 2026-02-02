/**
 * Validation utilities for ViveBien Core
 * Centralized validation logic for better maintainability
 */

/**
 * Validate UUID format
 */
export function isValidUUID(value: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate phone number format
 * Accepts: +1234567890 (10-15 digits after +)
 */
export function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[^\d+]/g, '');
  return /^\+\d{10,15}$/.test(cleaned);
}

/**
 * Normalize phone number (remove spaces, dashes, parentheses)
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)]/g, '');
}

/**
 * Validate language code
 */
export function isValidLanguage(lang: string): lang is 'es' | 'en' | 'pt' | 'fr' {
  return ['es', 'en', 'pt', 'fr'].includes(lang);
}

/**
 * Validate name format
 * - 1-4 words
 * - Each word 2-20 characters
 * - Only letters (including accented)
 */
export function isValidName(name: string): boolean {
  const words = name.trim().split(/\s+/);

  if (words.length < 1 || words.length > 4) {
    return false;
  }

  return words.every(word => {
    if (word.length < 2 || word.length > 20) {
      return false;
    }
    // Allow letters including accented characters
    return /^[\p{L}]+$/u.test(word);
  });
}

/**
 * Sanitize user input for safe storage
 * - Trim whitespace
 * - Remove control characters
 * - Limit length
 */
export function sanitizeInput(input: string, maxLength: number = 1000): string {
  return input
    .trim()
    // Remove control characters except newlines
    .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Limit length
    .substring(0, maxLength);
}

/**
 * Validate message content
 * - Not empty
 * - Not too long
 * - Contains printable characters
 */
export function isValidMessage(message: string): boolean {
  const sanitized = sanitizeInput(message);

  if (sanitized.length === 0) {
    return false;
  }

  if (sanitized.length > 10000) {
    return false;
  }

  // Must contain at least some printable characters
  return /[\p{L}\p{N}]/u.test(sanitized);
}

/**
 * Validate conversation ID
 */
export function isValidConversationId(id: number | string): boolean {
  const num = typeof id === 'string' ? parseInt(id, 10) : id;
  return Number.isInteger(num) && num > 0;
}

/**
 * Clean and validate summary content
 */
export function validateSummaryContent(content: string): { valid: boolean; cleaned: string } {
  const cleaned = sanitizeInput(content, 50000);

  return {
    valid: cleaned.length > 0,
    cleaned,
  };
}

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

export function isValidChatwootPayload(payload: unknown): payload is ChatwootWebhookPayload {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.event !== 'string') {
    return false;
  }

  if (!p.conversation || typeof p.conversation !== 'object') {
    return false;
  }

  const conv = p.conversation as Record<string, unknown>;

  if (typeof conv.id !== 'number') {
    return false;
  }

  return true;
}
