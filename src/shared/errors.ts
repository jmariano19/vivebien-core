// ============================================================================
// Base Error Classes
// ============================================================================

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================================
// HTTP Errors
// ============================================================================

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string = 'Too many requests', retryAfter?: number) {
    super(message, 429, 'RATE_LIMITED');
  }
}

// ============================================================================
// Business Logic Errors
// ============================================================================

export class InsufficientCreditsError extends AppError {
  constructor(required: number, available: number) {
    super(
      `Insufficient credits: required ${required}, available ${available}`,
      402,
      'INSUFFICIENT_CREDITS'
    );
  }
}

export class UserNotFoundError extends AppError {
  constructor(identifier: string) {
    super(`User not found: ${identifier}`, 404, 'USER_NOT_FOUND');
  }
}

export class ConversationNotFoundError extends AppError {
  constructor(conversationId: number) {
    super(`Conversation not found: ${conversationId}`, 404, 'CONVERSATION_NOT_FOUND');
  }
}

export class InvalidPhoneError extends AppError {
  constructor(phone: string) {
    super(`Invalid phone number: ${phone}`, 400, 'INVALID_PHONE');
  }
}

// ============================================================================
// External Service Errors
// ============================================================================

export class ExternalServiceError extends AppError {
  public readonly service: string;
  public readonly originalError?: Error;

  constructor(service: string, message: string, originalError?: Error) {
    super(`${service} error: ${message}`, 502, 'EXTERNAL_SERVICE_ERROR');
    this.service = service;
    this.originalError = originalError;
  }
}

export class AIServiceError extends ExternalServiceError {
  constructor(message: string, originalError?: Error) {
    super('AI', message, originalError);
  }
}

export class ChatwootError extends ExternalServiceError {
  constructor(message: string, originalError?: Error) {
    super('Chatwoot', message, originalError);
  }
}

export class WhisperError extends ExternalServiceError {
  constructor(message: string, originalError?: Error) {
    super('Whisper', message, originalError);
  }
}

// ============================================================================
// Database Errors
// ============================================================================

export class DatabaseError extends AppError {
  constructor(message: string, originalError?: Error) {
    super(`Database error: ${message}`, 500, 'DATABASE_ERROR', false);
  }
}

export class IdempotencyError extends AppError {
  constructor(key: string) {
    super(`Duplicate request detected: ${key}`, 409, 'IDEMPOTENCY_CONFLICT');
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>;

  constructor(errors: Record<string, string[]>) {
    const message = Object.entries(errors)
      .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
      .join('; ');

    super(message, 400, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

// ============================================================================
// Language/Localization Errors
// ============================================================================

export class LanguageDetectionError extends AppError {
  constructor(message: string = 'Could not detect language') {
    super(message, 400, 'LANGUAGE_DETECTION_FAILED');
  }
}

export class UnsupportedLanguageError extends AppError {
  constructor(language: string) {
    super(`Unsupported language: ${language}`, 400, 'UNSUPPORTED_LANGUAGE');
  }
}

// ============================================================================
// Error Utilities
// ============================================================================

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isOperationalError(error: unknown): boolean {
  if (isAppError(error)) {
    return error.isOperational;
  }
  return false;
}

export function toAppError(error: unknown): AppError {
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
export function isRetryableError(error: unknown): boolean {
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
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = isRetryableError,
  } = options;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
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
