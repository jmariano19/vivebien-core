import { FastifyPluginAsync } from 'fastify';
declare module 'fastify' {
    interface FastifyRequest {
        correlationId: string;
    }
}
export declare const correlationMiddleware: FastifyPluginAsync;
//# sourceMappingURL=correlation.d.ts.map