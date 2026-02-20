"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueEvents = exports.inboundQueue = exports.redis = void 0;
exports.getCheckinQueue = getCheckinQueue;
exports.addInboundJob = addInboundJob;
exports.getQueueStats = getQueueStats;
exports.checkRedisHealth = checkRedisHealth;
exports.closeRedis = closeRedis;
const bullmq_1 = require("bullmq");
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../../config");
const logger_1 = require("../logging/logger");
// Redis connection with production settings
exports.redis = new ioredis_1.default(config_1.config.redisUrl, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy: (times) => {
        if (times > 20) {
            logger_1.logger.error('Redis connection failed after 20 retries');
            return null; // Stop retrying
        }
        return Math.min(times * 100, 3000); // Exponential backoff, max 3s
    },
    reconnectOnError: (err) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
        return targetErrors.some((e) => err.message.includes(e));
    },
});
exports.redis.on('connect', () => {
    logger_1.logger.info('Redis connected');
});
exports.redis.on('error', (err) => {
    logger_1.logger.error({ error: err.message }, 'Redis error');
});
exports.redis.on('close', () => {
    logger_1.logger.warn('Redis connection closed');
});
// ============================================================================
// Queue Definitions
// ============================================================================
const QUEUE_NAME = 'vivebien-inbound';
const CHECKIN_QUEUE_NAME = 'vivebien-checkin';
exports.inboundQueue = new bullmq_1.Queue(QUEUE_NAME, {
    connection: exports.redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: {
            count: 1000, // Keep last 1000 completed jobs
            age: 3600, // Or 1 hour
        },
        removeOnFail: {
            count: 5000, // Keep last 5000 failed jobs for debugging
            age: 86400, // Or 24 hours
        },
    },
});
// Check-in queue for 24-hour follow-ups (delayed jobs)
let checkinQueue = null;
function getCheckinQueue() {
    if (!checkinQueue) {
        checkinQueue = new bullmq_1.Queue(CHECKIN_QUEUE_NAME, {
            connection: exports.redis,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 5000,
                },
                removeOnComplete: true,
                removeOnFail: {
                    count: 1000,
                    age: 86400 * 7, // Keep failed for 7 days
                },
            },
        });
    }
    return checkinQueue;
}
// Queue events for monitoring
exports.queueEvents = new bullmq_1.QueueEvents(QUEUE_NAME, {
    connection: exports.redis,
});
exports.queueEvents.on('completed', ({ jobId }) => {
    logger_1.logger.debug({ jobId }, 'Job completed event');
});
exports.queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger_1.logger.warn({ jobId, reason: failedReason }, 'Job failed event');
});
exports.queueEvents.on('stalled', ({ jobId }) => {
    logger_1.logger.warn({ jobId }, 'Job stalled event');
});
// ============================================================================
// Queue Operations
// ============================================================================
async function addInboundJob(data) {
    const job = await exports.inboundQueue.add(data.type, data, {
        jobId: data.correlationId, // Use correlation ID for idempotency
    });
    logger_1.logger.info({
        jobId: job.id,
        correlationId: data.correlationId,
        type: data.type,
    }, 'Job added to queue');
    return job.id;
}
async function getQueueStats() {
    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
        exports.inboundQueue.getWaitingCount(),
        exports.inboundQueue.getActiveCount(),
        exports.inboundQueue.getCompletedCount(),
        exports.inboundQueue.getFailedCount(),
        exports.inboundQueue.getDelayedCount(),
        exports.inboundQueue.isPaused(),
    ]);
    return { waiting, active, completed, failed, delayed, paused };
}
// ============================================================================
// Health Check
// ============================================================================
async function checkRedisHealth() {
    const start = Date.now();
    try {
        await exports.redis.ping();
        return {
            healthy: true,
            latencyMs: Date.now() - start,
        };
    }
    catch (error) {
        return {
            healthy: false,
            latencyMs: Date.now() - start,
        };
    }
}
// ============================================================================
// Cleanup
// ============================================================================
async function closeRedis() {
    await exports.inboundQueue.close();
    if (checkinQueue) {
        await checkinQueue.close();
    }
    await exports.queueEvents.close();
    await exports.redis.quit();
    logger_1.logger.info('Redis connections closed');
}
//# sourceMappingURL=client.js.map