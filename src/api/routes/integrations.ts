import { FastifyInstance } from 'fastify';
import { googleFitService } from '../../domain/integrations/googlefit/service';
import { logger } from '../../infra/logging/logger';

export async function integrationsRoutes(app: FastifyInstance) {

  /**
   * GET /api/integrations/googlefit/connect?userId=XXX
   * Redirects user to Google OAuth consent screen
   */
  app.get('/api/integrations/googlefit/connect', async (request, reply) => {
    const { userId } = request.query as { userId?: string };
    if (!userId) {
      return reply.code(400).send({ error: 'userId is required' });
    }
    const authUrl = googleFitService.getAuthUrl(userId);
    return reply.redirect(authUrl);
  });

  /**
   * GET /api/integrations/googlefit/callback
   * Google redirects here after user grants permission
   */
  app.get('/api/integrations/googlefit/callback', async (request, reply) => {
    const { code, state: userId, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    if (error || !code || !userId) {
      logger.warn({ error, userId }, 'Google Fit OAuth denied or missing params');
      return reply.redirect(`/${userId ?? ''}?fit=denied`);
    }

    try {
      await googleFitService.handleCallback(code, userId);
      logger.info({ userId }, 'Google Fit connected successfully');
      return reply.redirect(`/connect-googlefit?userId=${userId}&fit=connected`);
    } catch (err) {
      logger.error({ err, userId }, 'Google Fit callback error');
      return reply.redirect(`/connect-googlefit?userId=${userId}&fit=error`);
    }
  });

  /**
   * GET /api/integrations/googlefit/status/:userId
   * Check if a user has connected Google Fit
   */
  app.get('/api/integrations/googlefit/status/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      const connected = await googleFitService.isConnected(userId);
      return reply.send({ connected });
    } catch (err) {
      logger.error({ err, userId }, 'Error checking Google Fit status');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/integrations/googlefit/:userId
   * Disconnect Google Fit for a user
   */
  app.delete('/api/integrations/googlefit/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      await googleFitService.disconnect(userId);
      logger.info({ userId }, 'Google Fit disconnected');
      return reply.send({ success: true });
    } catch (err) {
      logger.error({ err, userId }, 'Error disconnecting Google Fit');
      return reply.code(500).send({ error: 'Internal server error' });
    }
  });
}
