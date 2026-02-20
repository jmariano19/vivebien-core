"use strict";
// ============================================================================
// Base Error Classes
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnsupportedLanguageError = exports.LanguageDetectionError = exports.ValidationError = exports.IdempotencyError = exports.DatabaseError = exports.WhisperError = exports.ChatwootError = exports.AIServiceError = exports.ExternalServiceError = exports.InvalidPhoneError = exports.ConversationNotFoundError = exports.UserNotFoundError = exports.InsufficientCreditsError = exports.TooManyRequestsError = exports.ConflictError = exports.NotFoundError = exports.ForbiddenError = exports.UnauthorizedError = exports.BadRequestError = exports.AppError = void 0;
exports.isAppError = isAppError;
exports.isOperationalError = isOperationalError;
exports.toAppError = toAppError;
exports.isRetryableError = isRetryableError;
exports.withRetry = withRetry;
class AppError extends Error {
    statusCode;
    isOperational;
    code;
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = isOperational;
        Object.setPrototypeOf(this, AppError.prototype);
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
// ============================================================================
// HTTP Errors
// ============================================================================
class BadRequestError extends AppError {
    constructor(message = 'Bad request') {
        super(message, 400, 'BAD_REQUEST');
    }
}
exports.BadRequestError = BadRequestError;
class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
    }
}
exports.ForbiddenError = ForbiddenError;
class NotFoundError extends AppError {
    constructor(message = 'Not found') {
        super(message, 404, 'NOT_FOUND');
    }
}
exports.NotFoundError = NotFoundError;
class ConflictError extends AppError {
    constructor(message = 'Conflict') {
        super(message, 409, 'CONFLICT');
    }
}
exports.ConflictError = ConflictError;
class TooManyRequestsError extends AppError {
    constructor(message = 'Too many requests', retryAfter) {
        super(message, 429, 'RATE_LIMITED');
    }
}
exports.TooManyRequestsError = TooManyRequestsError;
// ============================================================================
// Business Logic Errors
// ============================================================================
class InsufficientCreditsError extends AppError {
    constructor(required, available) {
        super(`Insufficient credits: required ${required}, available ${available}`, 402, 'INSUFFICIENT_CREDITS');
    }
}
exports.InsufficientCreditsError = InsufficientCreditsError;
class UserNotFoundError extends AppError {
    constructor(identifier) {
        super(`User not found: ${identifier}`, 404, 'USER_NOT_FOUND');
    }
}
exports.UserNotFoundError = UserNotFoundError;
class ConversationNotFoundError extends AppError {
    constructor(conversationId) {
        super(`Conversation not found: ${conversationId}`, 404, 'CONVERSATION_NOT_FOUND');
    }
}
exports.ConversationNotFoundError = ConversationNotFoundError;
class InvalidPhoneError extends AppError {
    constructor(phone) {
        super(`Invalid phone number: ${phone}`, 400, 'INVALID_PHONE');
    }
}
exports.InvalidPhoneError = InvalidPhoneError;
// ============================================================================
// External Service Errors
// ============================================================================
class ExternalServiceError extends AppError {
    service;
    originalError;
    constructor(service, message, originalError) {
        super(`${service} error: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR');
        this.service = service;
        this.originalError = originalError;
    }
}
exports.ExternalServiceError = ExternalServiceError;
class AIServiceError extends ExternalServiceError {
    constructor(message, originalError) {
        super('AI', message, originalError);
    }
}
exports.AIServiceError = AIServiceError;
class ChatwootError extends ExternalServiceError {
    constructor(message, originalError) {
        super('Chatwoot', message, originalError);
    }
}
exports.ChatwootError = ChatwootError;
class WhisperError extends ExternalServiceError {
    constructor(message, originalError) {
        super('Whisper', message, originalError);
    }
}
exports.WhisperError = WhisperError;
// ============================================================================
// Database Errors
// ============================================================================
class DatabaseError extends AppError {
    constructor(message, originalError) {
        super(`Database error: ${message}`, 500, 'DATABASE_ERROR', false);
    }
}
exports.DatabaseError = DatabaseError;
class IdempotencyError extends AppError {
    constructor(key) {
        super(`Duplicate request detected: ${key}`, 409, 'IDEMPOTENCY_CONFLICT');
    }
}
exports.IdempotencyError = IdempotencyError;
// ============================================================================
// Validation Errors
// ============================================================================
class ValidationError extends AppError {
    errors;
    constructor(errors) {
        const message = Object.entries(errors)
            .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
            .join('; ');
        super(message, 400, 'VALIDATION_ERROR');
        this.errors = errors;
    }
}
exports.ValidationError = ValidationError;
// ============================================================================
// Language/Localization Errors
// ============================================================================
class LanguageDetectionError extends AppError {
    constructor(message = 'Could not detect language') {
        super(message, 400, 'LANGUAGE_DETECTION_FAILED');
    }
}
exports.LanguageDetectionError = LanguageDetectionError;
class UnsupportedLanguageError extends AppError {
    constructor(language) {
        super(`Unsupported language: ${language}`, 400, 'UNSUPPORTED_LANGUAGE');
    }
}
exports.UnsupportedLanguageError = UnsupportedLanguageError;
// ============================================================================
// Error Utilities
// ============================================================================
function isAppError(error) {
    return error instanceof AppError;
}
function isOperationalError(error) {
    if (isAppError(error)) {
        return error.isOperational;
    }
    return false;
}
function toAppError(error) {
    if (isAppError(error)) {
        return error;
    }
    if (error instanceof Error) {
        return new AppError(error.message, 500, 'INTERNAL_ERROR', false);
    }
    return new AppError('Unknown error', 500, 'UNKNOWN_ERROR', false);
}
/**
 * Check if error is retryable (transient)
 */
function isRetryableError(error) {
    if (isAppError(error)) {
        // Rate limits and service unavailable are retryable
        if (error.statusCode === 429 || error.statusCode === 503) {
            return true;
        }
        // External service errors might be transient
        if (error instanceof ExternalServiceError) {
            return true;
        }
    }
    // Check for common transient error messages
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        const retryablePatterns = [
            'timeout',
            'econnreset',
            'econnrefused',
            'network',
            'temporarily unavailable',
            'rate limit',
            'too many requests',
        ];
        return retryablePatterns.some(pattern => message.includes(pattern));
    }
    return false;
}
/**
 * Retry a function with exponential backoff
 */
async function withRetry(fn, options = {}) {
    const { maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 10000, shouldRetry = isRetryableError, } = options;
    let lastError;
    let delay = initialDelayMs;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === maxRetries || !shouldRetry(error)) {
                throw error;
            }
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay));
            // Exponential backoff with jitter
            delay = Math.min(delay * 2 + Math.random() * 1000, maxDelayMs);
        }
    }
    throw lastError;
}
//# sourceMappingURL=errors.js.map