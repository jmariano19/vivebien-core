import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { checkDatabaseHealth } from '../../infra/db/client';
import { checkRedisHealth, getQueueStats } from '../../infra/queue/client';

const VERSION = process.env.npm_package_version || '0.1.0';

export const healthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Basic liveness check - always returns 200 if server is running
  app.get('/live', async (request, reply) => {
    return { status: 'ok' };
  });

  // Readiness check - returns 200 only if all dependencies are healthy
  app.get('/ready', async (request, reply) => {
    const [dbHealth, redisHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);

    const isReady = dbHealth.healthy && redisHealth.healthy;

    if (!isReady) {
      reply.status(503);
    }

    return {
      status: isReady ? 'ready' : 'not_ready',
      checks: {
        database: dbHealth.healthy ? 'ok' : 'fail',
        redis: redisHealth.healthy ? 'ok' : 'fail',
      },
    };
  });

  // Full health check with detailed metrics
  app.get('/health', async (request, reply) => {
    const [dbHealth, redisHealth, queueStats] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth(),
      getQueueStats(),
    ]);

    const isHealthy = dbHealth.healthy && redisHealth.healthy;

    // Determine if queue is healthy (not too backed up)
    const queueHealthy = queueStats.waiting < 10000 && !queueStats.paused;

    if (!isHealthy) {
      reply.status(503);
    }

    return {
      status: isHealthy ? 'healthy' : 'degraded',
      version: VERSION,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: {
          status: dbHealth.healthy ? 'ok' : 'fail',
          latencyMs: dbHealth.latencyMs,
          connections: dbHealth.connections,
        },
        redis: {
          status: redisHealth.healthy ? 'ok' : 'fail',
          latencyMs: redisHealth.latencyMs,
        },
        queue: {
          status: queueHealthy ? 'ok' : 'degraded',
          waiting: queueStats.waiting,
          active: queueStats.active,
          completed: queueStats.completed,
          failed: queueStats.failed,
          delayed: queueStats.delayed,
          paused: queueStats.paused,
        },
      },
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
  });
};
