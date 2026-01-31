import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const correlationPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    // Use existing correlation ID from header, or generate new one
    const correlationId =
      (request.headers['x-correlation-id'] as string) ||
      (request.headers['x-request-id'] as string) ||
      request.id;

    request.correlationId = correlationId;

    // Add to response headers
    reply.header('x-correlation-id', correlationId);

    // Add to logger context
    request.log = request.log.child({ correlationId });
  });
};

export const correlationMiddleware = fp(correlationPlugin, {
  name: 'correlation-middleware',
});
