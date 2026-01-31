import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config';
import { UnauthorizedError } from '../../shared/errors';

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip auth for health endpoints
  if (request.url.startsWith('/health') || request.url.startsWith('/live') || request.url.startsWith('/ready')) {
    return;
  }

  const apiKey = request.headers['x-api-key'] as string;
  const authHeader = request.headers['authorization'] as string;

  let token: string | undefined;

  // Check X-API-Key header first
  if (apiKey) {
    token = apiKey;
  }
  // Then check Authorization: Bearer header
  else if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    throw new UnauthorizedError('Missing API key or authorization token');
  }

  // Validate token
  if (token !== config.apiSecretKey) {
    request.log.warn({ providedKey: token.substring(0, 8) + '...' }, 'Invalid API key attempt');
    throw new UnauthorizedError('Invalid API key');
  }

  // Token is valid - could add additional claims/permissions here
  request.log.debug('API key validated');
}

// Optional: Rate limiting decorator for specific endpoints
export function rateLimit(options: {
  windowMs: number;
  maxRequests: number;
}) {
  const requests = new Map<string, { count: number; resetAt: number }>();

  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const key = request.ip;
    const now = Date.now();

    let record = requests.get(key);

    // Clean up expired records periodically
    if (requests.size > 10000) {
      for (const [k, v] of requests.entries()) {
        if (v.resetAt < now) {
          requests.delete(k);
        }
      }
    }

    if (!record || record.resetAt < now) {
      record = {
        count: 0,
        resetAt: now + options.windowMs,
      };
      requests.set(key, record);
    }

    record.count++;

    reply.header('X-RateLimit-Limit', options.maxRequests);
    reply.header('X-RateLimit-Remaining', Math.max(0, options.maxRequests - record.count));
    reply.header('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

    if (record.count > options.maxRequests) {
      reply.status(429);
      throw new Error('Too many requests');
    }
  };
}
