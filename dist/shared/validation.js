"use strict";
/**
 * Validation utilities for ViveBien Core
 * Centralized validation logic for better maintainability
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidUUID = isValidUUID;
exports.isValidPhone = isValidPhone;
exports.normalizePhone = normalizePhone;
exports.isValidLanguage = isValidLanguage;
exports.isValidName = isValidName;
exports.sanitizeInput = sanitizeInput;
exports.isValidMessage = isValidMessage;
exports.isValidConversationId = isValidConversationId;
exports.validateSummaryContent = validateSummaryContent;
exports.isValidChatwootPayload = isValidChatwootPayload;
/**
 * Validate UUID format
 */
function isValidUUID(value) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(value);
}
/**
 * Validate phone number format
 * Accepts: +1234567890 (10-15 digits after +)
 */
function isValidPhone(phone) {
    const cleaned = phone.replace(/[^\d+]/g, '');
    return /^\+\d{10,15}$/.test(cleaned);
}
/**
 * Normalize phone number (remove spaces, dashes, parentheses)
 */
function normalizePhone(phone) {
    return phone.replace(/[\s\-\(\)]/g, '');
}
/**
 * Validate language code
 */
function isValidLanguage(lang) {
    return ['es', 'en', 'pt', 'fr'].includes(lang);
}
/**
 * Validate name format
 * - 1-4 words
 * - Each word 2-20 characters
 * - Only letters (including accented)
 */
function isValidName(name) {
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
function sanitizeInput(input, maxLength = 1000) {
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
function isValidMessage(message) {
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
function isValidConversationId(id) {
    const num = typeof id === 'string' ? parseInt(id, 10) : id;
    return Number.isInteger(num) && num > 0;
}
/**
 * Clean and validate summary content
 */
function validateSummaryContent(content) {
    const cleaned = sanitizeInput(content, 50000);
    return {
        valid: cleaned.length > 0,
        cleaned,
    };
}
function isValidChatwootPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const p = payload;
    if (typeof p.event !== 'string') {
        return false;
    }
    if (!p.conversation || typeof p.conversation !== 'object') {
        return false;
    }
    const conv = p.conversation;
    if (typeof conv.id !== 'number') {
        return false;
    }
    return true;
}
//# sourceMappingURL=validation.js.map