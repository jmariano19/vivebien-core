"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.integrationsRoutes = integrationsRoutes;
const service_1 = require("../../domain/integrations/googlefit/service");
const logger_1 = require("../../infra/logging/logger");
async function integrationsRoutes(app) {
    /**
     * GET /api/integrations/googlefit/connect?userId=XXX
     * Redirects user to Google OAuth consent screen
     */
    app.get('/api/integrations/googlefit/connect', async (request, reply) => {
        const { userId } = request.query;
        if (!userId) {
            return reply.code(400).send({ error: 'userId is required' });
        }
        const authUrl = service_1.googleFitService.getAuthUrl(userId);
        return reply.redirect(authUrl);
    });
    /**
     * GET /api/integrations/googlefit/callback
     * Google redirects here after user grants permission
     */
    app.get('/api/integrations/googlefit/callback', async (request, reply) => {
        const { code, state: userId, error } = request.query;
        if (error || !code || !userId) {
            logger_1.logger.warn({ error, userId }, 'Google Fit OAuth denied or missing params');
            return reply.redirect(`/${userId ?? ''}?fit=denied`);
        }
        try {
            await service_1.googleFitService.handleCallback(code, userId);
            logger_1.logger.info({ userId }, 'Google Fit connected successfully');
            return reply.redirect(`/connect-googlefit?userId=${userId}&fit=connected`);
        }
        catch (err) {
            logger_1.logger.error({ err, userId }, 'Google Fit callback error');
            return reply.redirect(`/connect-googlefit?userId=${userId}&fit=error`);
        }
    });
    /**
     * GET /api/integrations/googlefit/status/:userId
     * Check if a user has connected Google Fit
     */
    app.get('/api/integrations/googlefit/status/:userId', async (request, reply) => {
        const { userId } = request.params;
        try {
            const connected = await service_1.googleFitService.isConnected(userId);
            return reply.send({ connected });
        }
        catch (err) {
            logger_1.logger.error({ err, userId }, 'Error checking Google Fit status');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
    /**
     * DELETE /api/integrations/googlefit/:userId
     * Disconnect Google Fit for a user
     */
    app.delete('/api/integrations/googlefit/:userId', async (request, reply) => {
        const { userId } = request.params;
        try {
            await service_1.googleFitService.disconnect(userId);
            logger_1.logger.info({ userId }, 'Google Fit disconnected');
            return reply.send({ success: true });
        }
        catch (err) {
            logger_1.logger.error({ err, userId }, 'Error disconnecting Google Fit');
            return reply.code(500).send({ error: 'Internal server error' });
        }
    });
}
//# sourceMappingURL=integrations.js.map