import { FastifyRequest, FastifyReply } from 'fastify';
export declare function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function rateLimit(options: {
    windowMs: number;
    maxRequests: number;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
//# sourceMappingURL=auth.d.ts.map