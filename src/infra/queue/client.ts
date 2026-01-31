import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../../config';
import { logger } from '../logging/logger';
import { InboundJobData } from '../../shared/types';

// Redis connection with production settings
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  retryStrategy: (times: number) => {
    if (times > 20) {
      logger.error('Redis connection failed after 20 retries');
      return null; // Stop retrying
    }
    return Math.min(times * 100, 3000); // Exponential backoff, max 3s
  },
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    return targetErrors.some((e) => err.message.includes(e));
  },
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error({ error: err.message }, 'Redis error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

// ============================================================================
// Queue Definitions
// ============================================================================

const QUEUE_NAME = 'vivebien-inbound';

export const inboundQueue = new Queue<InboundJobData>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      count: 1000,  // Keep last 1000 completed jobs
      age: 3600,    // Or 1 hour
    },
    removeOnFail: {
      count: 5000,  // Keep last 5000 failed jobs for debugging
      age: 86400,   // Or 24 hours
    },
  },
});

// Queue events for monitoring
export const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redis,
});

queueEvents.on('completed', ({ jobId }) => {
  logger.debug({ jobId }, 'Job completed event');
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn({ jobId, reason: failedReason }, 'Job failed event');
});

queueEvents.on('stalled', ({ jobId }) => {
  logger.warn({ jobId }, 'Job stalled event');
});

// ============================================================================
// Queue Operations
// ============================================================================

export async function addInboundJob(data: InboundJobData): Promise<string> {
  const job = await inboundQueue.add(data.type, data, {
    jobId: data.correlationId, // Use correlation ID for idempotency
  });

  logger.info({
    jobId: job.id,
    correlationId: data.correlationId,
    type: data.type,
  }, 'Job added to queue');

  return job.id!;
}

export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}> {
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    inboundQueue.getWaitingCount(),
    inboundQueue.getActiveCount(),
    inboundQueue.getCompletedCount(),
    inboundQueue.getFailedCount(),
    inboundQueue.getDelayedCount(),
    inboundQueue.isPaused(),
  ]);

  return { waiting, active, completed, failed, delayed, paused };
}

// ============================================================================
// Health Check
// ============================================================================

export async function checkRedisHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
}> {
  const start = Date.now();

  try {
    await redis.ping();
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
    };
  }
}

// ============================================================================
// Cleanup
// ============================================================================

export async function closeRedis(): Promise<void> {
  await inboundQueue.close();
  await queueEvents.close();
  await redis.quit();
  logger.info('Redis connections closed');
}
