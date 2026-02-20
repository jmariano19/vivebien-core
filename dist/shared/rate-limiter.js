"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributedRateLimiter = exports.RateLimiter = void 0;
const errors_1 = require("./errors");
/**
 * Simple in-memory rate limiter using token bucket algorithm
 * For distributed rate limiting, use Redis-based implementation
 */
class RateLimiter {
    tokens;
    maxTokens;
    refillRate; // tokens per ms
    lastRefill;
    maxWaitMs;
    waitQueue = [];
    constructor(options) {
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
    async acquire() {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return;
        }
        // Calculate wait time
        const tokensNeeded = 1 - this.tokens;
        const waitMs = Math.ceil(tokensNeeded / this.refillRate);
        if (waitMs > this.maxWaitMs) {
            throw new errors_1.TooManyRequestsError(`Rate limit exceeded. Try again in ${Math.ceil(waitMs / 1000)} seconds`);
        }
        // Wait for token
        await new Promise((resolve) => {
            this.waitQueue.push(resolve);
            setTimeout(() => {
                this.refill();
                this.tokens -= 1;
                const resolver = this.waitQueue.shift();
                if (resolver)
                    resolver();
            }, waitMs);
        });
    }
    /**
     * Try to acquire a token without waiting
     * Returns false if no tokens available
     */
    tryAcquire() {
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
    getAvailableTokens() {
        this.refill();
        return Math.floor(this.tokens);
    }
    /**
     * Get estimated wait time in ms for next token
     */
    getWaitTime() {
        this.refill();
        if (this.tokens >= 1) {
            return 0;
        }
        const tokensNeeded = 1 - this.tokens;
        return Math.ceil(tokensNeeded / this.refillRate);
    }
    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const refillAmount = elapsed * this.refillRate;
        this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
        this.lastRefill = now;
    }
}
exports.RateLimiter = RateLimiter;
/**
 * Redis-based distributed rate limiter
 * Use this when running multiple worker instances
 */
class DistributedRateLimiter {
    redis; // ioredis instance
    key;
    maxRequests;
    windowMs;
    constructor(redis, key, maxRequestsPerMinute) {
        this.redis = redis;
        this.key = `ratelimit:${key}`;
        this.maxRequests = maxRequestsPerMinute;
        this.windowMs = 60000;
    }
    async acquire() {
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
        const currentCount = results[1][1];
        if (currentCount >= this.maxRequests) {
            // Remove the entry we just added
            await this.redis.zremrangebyscore(this.key, now, now);
            throw new errors_1.TooManyRequestsError('Rate limit exceeded');
        }
    }
    async getUsage() {
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
exports.DistributedRateLimiter = DistributedRateLimiter;
//# sourceMappingURL=rate-limiter.js.map