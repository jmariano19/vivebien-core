import { Worker, Job } from 'bullmq';
import { redis, closeRedis } from '../infra/queue/client';
import { processJob } from './processor';
import { config } from '../config';
import { logger } from '../infra/logging/logger';
import { db } from '../infra/db/client';

const QUEUE_NAME = 'vivebien-inbound';

const worker = new Worker(QUEUE_NAME, processJob, {
  connection: redis,
  concurrency: config.workerConcurrency,
  maxStalledCount: 2,
  stalledInterval: 30000,
  lockDuration: config.jobTimeoutMs,
  settings: {
    backoffStrategy: (attemptsMade: number) => {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s max
      return Math.min(Math.pow(2, attemptsMade) * 1000, 16000);
    },
  },
});

// Event handlers
worker.on('ready', () => {
  logger.info({ queue: QUEUE_NAME, concurrency: config.workerConcurrency }, 'Worker ready');
});

worker.on('completed', (job: Job) => {
  logger.info({
    jobId: job.id,
    correlationId: job.data.correlationId,
    duration: Date.now() - job.timestamp,
  }, 'Job completed');
});

worker.on('failed', (job: Job | undefined, err: Error) => {
  logger.error({
    jobId: job?.id,
    correlationId: job?.data?.correlationId,
    error: err.message,
    stack: err.stack,
    attemptsMade: job?.attemptsMade,
  }, 'Job failed');
});

worker.on('error', (err: Error) => {
  logger.error({ error: err.message }, 'Worker error');
});

worker.on('stalled', (jobId: string) => {
  logger.warn({ jobId }, 'Job stalled');
});

// Graceful shutdown
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Worker received shutdown signal');

  try {
    // Stop accepting new jobs
    await worker.pause();
    logger.info('Worker paused, waiting for active jobs...');

    // Wait for active jobs to complete (max 30 seconds)
    const timeout = setTimeout(() => {
      logger.warn('Shutdown timeout, forcing close');
      process.exit(1);
    }, 30000);

    await worker.close();
    clearTimeout(timeout);

    await db.end();
    await closeRedis();

    logger.info('Worker shut down gracefully');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

logger.info({ queue: QUEUE_NAME }, 'Worker starting...');
