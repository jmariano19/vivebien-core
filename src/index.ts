import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { healthRoutes } from './api/routes/health';
import { ingestRoutes } from './api/routes/ingest';
import { adminRoutes } from './api/routes/admin';
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
  // CORS for admin dashboard access
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });

  // Correlation ID middleware
  await app.register(correlationMiddleware);

  // Routes
  await app.register(healthRoutes);
  await app.register(ingestRoutes);
  await app.register(adminRoutes, { prefix: '/admin' });

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
