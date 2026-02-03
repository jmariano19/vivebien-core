import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { config } from './config';
import { healthRoutes } from './api/routes/health';
import { ingestRoutes } from './api/routes/ingest';
import { adminRoutes } from './api/routes/admin';
import { summaryRoutes } from './api/routes/summary';
import { doctorRoutes } from './api/routes/doctor';
import { correlationMiddleware } from './api/middleware/correlation';
import { logger } from './infra/logging/logger';
import { db } from './infra/db/client';
import { redis, closeRedis } from './infra/queue/client';

const app = Fastify({
  logger: logger,
  requestIdHeader: 'x-correlation-id',
  genReqId: () => crypto.randomUUID(),
});

// Graceful shutdown handler
let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing server...');

  try {
    await app.close();
    await db.end();
    await closeRedis();
    logger.info('Server closed gracefully');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Register plugins and middleware
async function bootstrap() {
  logger.info('Starting ViveBien Core API bootstrap...');
  // CORS for admin dashboard access
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  // Static files for dashboard
  const publicPath = path.join(__dirname, '..', 'public');
  try {
    await app.register(fastifyStatic, {
      root: publicPath,
      prefix: '/',
      index: ['index.html'],
      decorateReply: true,
    });
    logger.info({ path: publicPath }, 'Static file serving enabled');
  } catch (err) {
    logger.warn({ err, path: publicPath }, 'Static file serving failed - dashboard may not be available');
  }

  // Correlation ID middleware
  await app.register(correlationMiddleware);

  // Routes
  await app.register(healthRoutes);
  await app.register(ingestRoutes);
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(summaryRoutes, { prefix: '/api/summary' });
  await app.register(doctorRoutes, { prefix: '/api/doctor' });

  // Serve doctor view page for /doctor/:userId URLs
  app.get('/doctor/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Only serve for UUID-like paths
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(userId)) {
      return reply.sendFile('doctor.html');
    }
    return reply.status(404).send({ error: 'Not found' });
  });

  // Serve summary landing page for /:userId URLs
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Skip requests with file extensions - let static file handler serve those
    if (userId.includes('.')) {
      // Pass to next handler (static files)
      return reply.callNotFound();
    }

    // Only serve for UUID-like paths (avoid conflicts with other routes)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(userId)) {
      return reply.sendFile('summary.html');
    }
    // Not a UUID, return 404
    return reply.status(404).send({ error: 'Not found' });
  });

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;

    logger.error({
      correlationId,
      error: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
    }, 'Request error');

    // Don't expose internal errors
    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? 'Internal server error' : error.message;

    reply.status(statusCode).send({
      success: false,
      error: message,
      correlationId,
    });
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port, env: config.nodeEnv }, 'Server started');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

bootstrap();
