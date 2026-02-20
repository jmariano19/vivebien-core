interface RateLimiterOptions {
    maxRequestsPerMinute: number;
    maxWaitMs?: number;
}
/**
 * Simple in-memory rate limiter using token bucket algorithm
 * For distributed rate limiting, use Redis-based implementation
 */
export declare class RateLimiter {
    private tokens;
    private maxTokens;
    private refillRate;
    private lastRefill;
    private maxWaitMs;
    private waitQueue;
    constructor(options: RateLimiterOptions);
    /**
     * Acquire a token, waiting if necessary
     * Throws TooManyRequestsError if wait would exceed maxWaitMs
     */
    acquire(): Promise<void>;
    /**
     * Try to acquire a token without waiting
     * Returns false if no tokens available
     */
    tryAcquire(): boolean;
    /**
     * Get current available tokens
     */
    getAvailableTokens(): number;
    /**
     * Get estimated wait time in ms for next token
     */
    getWaitTime(): number;
    private refill;
}
/**
 * Redis-based distributed rate limiter
 * Use this when running multiple worker instances
 */
export declare class DistributedRateLimiter {
    private redis;
    private key;
    private maxRequests;
    private windowMs;
    constructor(redis: any, key: string, maxRequestsPerMinute: number);
    acquire(): Promise<void>;
    getUsage(): Promise<{
        used: number;
        limit: number;
        remaining: number;
    }>;
}
export {};
//# sourceMappingURL=rate-limiter.d.ts.map