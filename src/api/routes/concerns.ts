import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { queryOne, db } from '../../infra/db/client';
import { ConcernService, ConcernStatus } from '../../domain/concern/service';

const concernService = new ConcernService(db);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const concernRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {

  /**
   * GET /api/concerns/:userId
   * Get all concerns for a user (active first, then resolved)
   */
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    if (!UUID_REGEX.test(userId)) {
      return reply.status(400).send({ error: 'Invalid user ID format' });
    }

    // Verify user exists and get language
    const user = await queryOne<{ id: string; language: string; name: string | null }>(
      `SELECT id, COALESCE(language, 'es') as language, name FROM users WHERE id = $1`,
      [userId]
    );

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    try {
      const concerns = await concernService.getAllConcerns(userId);

      return {
        userId: user.id,
        userName: user.name,
        language: user.language,
        concerns: concerns.map(c => ({
          id: c.id,
          title: c.title,
          status: c.status,
          summaryContent: c.summaryContent,
          icon: c.icon,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      };
    } catch (err) {
      // Table may not exist yet
      return { userId: user.id, userName: user.name, language: user.language, concerns: [] };
    }
  });

  /**
   * GET /api/concerns/:userId/:concernId
   * Get a single concern with full detail
   */
  app.get('/:userId/:concernId', async (request, reply) => {
    const { userId, concernId } = request.params as { userId: string; concernId: string };

    if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(concernId)) {
      return reply.status(400).send({ error: 'Invalid ID format' });
    }

    try {
      const concern = await concernService.getConcernById(concernId);
      if (!concern || concern.userId !== userId) {
        return reply.status(404).send({ error: 'Concern not found' });
      }

      const user = await queryOne<{ language: string; name: string | null }>(
        `SELECT COALESCE(language, 'es') as language, name FROM users WHERE id = $1`,
        [userId]
      );

      return {
        ...concern,
        language: user?.language || 'es',
        userName: user?.name,
      };
    } catch (err) {
      request.log.error({ err, userId, concernId }, 'Failed to fetch concern');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * PUT /api/concerns/:userId/:concernId
   * Update a concern's summary content (from edit page)
   */
  app.put('/:userId/:concernId', async (request, reply) => {
    const { userId, concernId } = request.params as { userId: string; concernId: string };
    const { summary, title } = request.body as { summary?: string; title?: string };

    if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(concernId)) {
      return reply.status(400).send({ error: 'Invalid ID format' });
    }

    const concern = await concernService.getConcernById(concernId);
    if (!concern || concern.userId !== userId) {
      return reply.status(404).send({ error: 'Concern not found' });
    }

    try {
      if (summary) {
        await concernService.updateConcernSummary(concernId, summary, 'user_edit');
      }

      if (title) {
        await db.query(
          `UPDATE health_concerns SET title = $1, updated_at = NOW() WHERE id = $2`,
          [title, concernId]
        );
      }

      return { success: true, updatedAt: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err, userId, concernId }, 'Failed to update concern');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * PUT /api/concerns/:userId/:concernId/status
   * Change concern status (active → improving → resolved)
   */
  app.put('/:userId/:concernId/status', async (request, reply) => {
    const { userId, concernId } = request.params as { userId: string; concernId: string };
    const { status } = request.body as { status: ConcernStatus };

    if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(concernId)) {
      return reply.status(400).send({ error: 'Invalid ID format' });
    }

    const validStatuses: ConcernStatus[] = ['active', 'improving', 'resolved'];
    if (!validStatuses.includes(status)) {
      return reply.status(400).send({ error: 'Invalid status. Must be: active, improving, or resolved' });
    }

    try {
      const concern = await concernService.getConcernById(concernId);
      if (!concern || concern.userId !== userId) {
        return reply.status(404).send({ error: 'Concern not found' });
      }

      await concernService.updateConcernStatus(concernId, status);

      return { success: true, status, updatedAt: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err, userId, concernId }, 'Failed to update concern status');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/concerns/:userId/:concernId
   * Delete a concern and all its snapshots
   */
  app.delete('/:userId/:concernId', async (request, reply) => {
    const { userId, concernId } = request.params as { userId: string; concernId: string };

    if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(concernId)) {
      return reply.status(400).send({ error: 'Invalid ID format' });
    }

    try {
      const concern = await concernService.getConcernById(concernId);
      if (!concern || concern.userId !== userId) {
        return reply.status(404).send({ error: 'Concern not found' });
      }

      await concernService.deleteConcern(concernId);

      return { success: true };
    } catch (err) {
      request.log.error({ err, userId, concernId }, 'Failed to delete concern');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/concerns/:userId/:concernId/history
   * Get snapshot timeline for a specific concern
   */
  app.get('/:userId/:concernId/history', async (request, reply) => {
    const { userId, concernId } = request.params as { userId: string; concernId: string };

    if (!UUID_REGEX.test(userId) || !UUID_REGEX.test(concernId)) {
      return reply.status(400).send({ error: 'Invalid ID format' });
    }

    try {
      const concern = await concernService.getConcernById(concernId);
      if (!concern || concern.userId !== userId) {
        return reply.status(404).send({ error: 'Concern not found' });
      }

      const snapshots = await concernService.getConcernHistory(concernId);

      return {
        concernId: concern.id,
        title: concern.title,
        status: concern.status,
        snapshots: snapshots.map(s => ({
          id: s.id,
          content: s.content,
          changeType: s.changeType,
          status: s.status,
          createdAt: s.createdAt,
        })),
      };
    } catch (err) {
      request.log.error({ err, concernId }, 'Failed to fetch concern history');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
};
