"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.correlationMiddleware = void 0;
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const correlationPlugin = async (app) => {
    app.decorateRequest('correlationId', '');
    app.addHook('onRequest', async (request, reply) => {
        // Use existing correlation ID from header, or generate new one
        const correlationId = request.headers['x-correlation-id'] ||
            request.headers['x-request-id'] ||
            request.id;
        request.correlationId = correlationId;
        // Add to response headers
        reply.header('x-correlation-id', correlationId);
        // Add to logger context
        request.log = request.log.child({ correlationId });
    });
};
exports.correlationMiddleware = (0, fastify_plugin_1.default)(correlationPlugin, {
    name: 'correlation-middleware',
});
//# sourceMappingURL=correlation.js.map