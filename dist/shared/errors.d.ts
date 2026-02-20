export declare class AppError extends Error {
    readonly statusCode: number;
    readonly isOperational: boolean;
    readonly code: string;
    constructor(message: string, statusCode?: number, code?: string, isOperational?: boolean);
}
export declare class BadRequestError extends AppError {
    constructor(message?: string);
}
export declare class UnauthorizedError extends AppError {
    constructor(message?: string);
}
export declare class ForbiddenError extends AppError {
    constructor(message?: string);
}
export declare class NotFoundError extends AppError {
    constructor(message?: string);
}
export declare class ConflictError extends AppError {
    constructor(message?: string);
}
export declare class TooManyRequestsError extends AppError {
    constructor(message?: string, retryAfter?: number);
}
export declare class InsufficientCreditsError extends AppError {
    constructor(required: number, available: number);
}
export declare class UserNotFoundError extends AppError {
    constructor(identifier: string);
}
export declare class ConversationNotFoundError extends AppError {
    constructor(conversationId: number);
}
export declare class InvalidPhoneError extends AppError {
    constructor(phone: string);
}
export declare class ExternalServiceError extends AppError {
    readonly service: string;
    readonly originalError?: Error;
    constructor(service: string, message: string, originalError?: Error);
}
export declare class AIServiceError extends ExternalServiceError {
    constructor(message: string, originalError?: Error);
}
export declare class ChatwootError extends ExternalServiceError {
    constructor(message: string, originalError?: Error);
}
export declare class WhisperError extends ExternalServiceError {
    constructor(message: string, originalError?: Error);
}
export declare class DatabaseError extends AppError {
    constructor(message: string, originalError?: Error);
}
export declare class IdempotencyError extends AppError {
    constructor(key: string);
}
export declare class ValidationError extends AppError {
    readonly errors: Record<string, string[]>;
    constructor(errors: Record<string, string[]>);
}
export declare class LanguageDetectionError extends AppError {
    constructor(message?: string);
}
export declare class UnsupportedLanguageError extends AppError {
    constructor(language: string);
}
export declare function isAppError(error: unknown): error is AppError;
export declare function isOperationalError(error: unknown): boolean;
export declare function toAppError(error: unknown): AppError;
/**
 * Check if error is retryable (transient)
 */
export declare function isRetryableError(error: unknown): boolean;
/**
 * Retry a function with exponential backoff
 */
export declare function withRetry<T>(fn: () => Promise<T>, options?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
}): Promise<T>;
//# sourceMappingURL=errors.d.ts.map