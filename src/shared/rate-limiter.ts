import { TooManyRequestsError } from './errors';

interface RateLimiterOptions {
  maxRequestsPerMinute: number;
  maxWaitMs?: number;
}

/**
 * Simple in-memory rate limiter using token bucket algorithm
 * For distributed rate limiting, use Redis-based implementation
 */
export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;
  private maxWaitMs: number;
  private waitQueue: Array<() => void> = [];

  constructor(options: RateLimiterOptions) {
    this.maxTokens = options.maxRequestsPerMinute;
    this.tokens = this.maxTokens;
    this.refillRate = options.maxRequestsPerMinute / 60000; // per ms
    this.lastRefill = Date.now();
    this.maxWaitMs = options.maxWaitMs || 30000; // 30 second default
  }

  /**
   * Acquire a token, waiting if necessary
   * Throws TooManyRequestsError if wait would exceed maxWaitMs
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.ceil(tokensNeeded / this.refillRate);

    if (waitMs > this.maxWaitMs) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Try again in ${Math.ceil(waitMs / 1000)} seconds`
      );
    }

    // Wait for token
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
      setTimeout(() => {
        this.refill();
        this.tokens -= 1;
        const resolver = this.waitQueue.shift();
        if (resolver) resolver();
      }, waitMs);
    });
  }

  /**
   * Try to acquire a token without waiting
   * Returns false if no tokens available
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get current available tokens
   */
  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Get estimated wait time in ms for next token
   */
  getWaitTime(): number {
    this.refill();

    if (this.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.tokens;
    return Math.ceil(tokensNeeded / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }
}

/**
 * Redis-based distributed rate limiter
 * Use this when running multiple worker instances
 */
export class DistributedRateLimiter {
  private redis: any; // ioredis instance
  private key: string;
  private maxRequests: number;
  private windowMs: number;

  constructor(redis: any, key: string, maxRequestsPerMinute: number) {
    this.redis = redis;
    this.key = `ratelimit:${key}`;
    this.maxRequests = maxRequestsPerMinute;
    this.windowMs = 60000;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Use Redis sorted set for sliding window
    const pipeline = this.redis.pipeline();

    // Remove old entries
    pipeline.zremrangebyscore(this.key, 0, windowStart);

    // Count current entries
    pipeline.zcard(this.key);

    // Add new entry
    pipeline.zadd(this.key, now, `${now}-${Math.random()}`);

    // Set expiry
    pipeline.expire(this.key, Math.ceil(this.windowMs / 1000) + 1);

    const results = await pipeline.exec();
    const currentCount = results[1][1] as number;

    if (currentCount >= this.maxRequests) {
      // Remove the entry we just added
      await this.redis.zremrangebyscore(this.key, now, now);
      throw new TooManyRequestsError('Rate limit exceeded');
    }
  }

  async getUsage(): Promise<{ used: number; limit: number; remaining: number }> {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    await this.redis.zremrangebyscore(this.key, 0, windowStart);
    const used = await this.redis.zcard(this.key);

    return {
      used,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - used),
    };
  }
}
