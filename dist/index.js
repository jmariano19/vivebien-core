"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const static_1 = __importDefault(require("@fastify/static"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const health_1 = require("./api/routes/health");
const ingest_1 = require("./api/routes/ingest");
const admin_1 = require("./api/routes/admin");
const summary_1 = require("./api/routes/summary");
const concerns_1 = require("./api/routes/concerns");
const doctor_1 = require("./api/routes/doctor");
const test_1 = require("./api/routes/test");
const meals_1 = require("./api/routes/meals");
const digests_1 = require("./api/routes/digests");
const correlation_1 = require("./api/middleware/correlation");
const logger_1 = require("./infra/logging/logger");
const client_1 = require("./infra/db/client");
const client_2 = require("./infra/queue/client");
const app = (0, fastify_1.default)({
    logger: logger_1.logger,
    requestIdHeader: 'x-correlation-id',
    genReqId: () => crypto.randomUUID(),
});
// Graceful shutdown handler
let isShuttingDown = false;
const shutdown = async (signal) => {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    logger_1.logger.info({ signal }, 'Received shutdown signal, closing server...');
    try {
        await app.close();
        await client_1.db.end();
        await (0, client_2.closeRedis)();
        logger_1.logger.info('Server closed gracefully');
        process.exit(0);
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Error during shutdown');
        process.exit(1);
    }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// Register plugins and middleware
async function bootstrap() {
    logger_1.logger.info('Starting Plato Inteligente API bootstrap...');
    // CORS for admin dashboard access
    await app.register(cors_1.default, {
        origin: config_1.config.corsOrigins,
        credentials: true,
    });
    // Static files for dashboard
    const publicPath = path_1.default.join(__dirname, '..', 'public');
    try {
        await app.register(static_1.default, {
            root: publicPath,
            prefix: '/',
            index: ['index.html'],
            decorateReply: true,
        });
        logger_1.logger.info({ path: publicPath }, 'Static file serving enabled');
    }
    catch (err) {
        logger_1.logger.warn({ err, path: publicPath }, 'Static file serving failed - dashboard may not be available');
    }
    // Correlation ID middleware
    await app.register(correlation_1.correlationMiddleware);
    // Routes
    await app.register(health_1.healthRoutes);
    await app.register(ingest_1.ingestRoutes);
    await app.register(admin_1.adminRoutes, { prefix: '/admin' });
    await app.register(summary_1.summaryRoutes, { prefix: '/api/summary' });
    await app.register(concerns_1.concernRoutes, { prefix: '/api/concerns' });
    await app.register(doctor_1.doctorRoutes, { prefix: '/api/doctor' });
    await app.register(test_1.testRoutes, { prefix: '/api/test' });
    await app.register(meals_1.mealRoutes, { prefix: '/api/meals' });
    await app.register(digests_1.digestRoutes, { prefix: '/api/digests' });
    // Serve Plato Inteligente pages
    // Journal page — meal timeline
    app.get('/journal/:userId', async (request, reply) => {
        const { userId } = request.params;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('journal.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Digest page — daily summary with PDF + audio
    app.get('/digest/:userId', async (request, reply) => {
        const { userId } = request.params;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('digest.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Patterns page — food pattern library
    app.get('/patterns/:userId', async (request, reply) => {
        const { userId } = request.params;
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('patterns.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve doctor view page for /doctor/:userId URLs
    app.get('/doctor/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Only serve for UUID-like paths
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('doctor.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve appointment page for /appointment/:userId URLs
    app.get('/appointment/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Only serve for UUID-like paths
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('appointment.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve suggest change page for /suggest/:userId URLs
    app.get('/suggest/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Only serve for UUID-like paths
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('suggest.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve history page for /history/:userId URLs
    app.get('/history/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Only serve for UUID-like paths
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('history.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve questions page for /questions/:userId URLs
    app.get('/questions/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Only serve for UUID-like paths
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(userId)) {
            return reply.sendFile('questions.html');
        }
        return reply.status(404).send({ error: 'Not found' });
    });
    // Serve summary landing page for /:userId URLs
    app.get('/:userId', async (request, reply) => {
        const { userId } = request.params;
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
        logger_1.logger.error({
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
        await app.listen({ port: config_1.config.port, host: '0.0.0.0' });
        logger_1.logger.info({ port: config_1.config.port, env: config_1.config.nodeEnv }, 'Server started');
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}
bootstrap();
//# sourceMappingURL=index.js.map