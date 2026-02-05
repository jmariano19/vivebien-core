import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { queryOne, queryMany, query, db } from '../../infra/db/client';
import { NotFoundError } from '../../shared/errors';
import { ConcernService } from '../../domain/concern/service';

export const summaryRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ============================================================================
  // Health Summary Endpoints (for website integration)
  // ============================================================================

  /**
   * Get health summary by user ID (simple endpoint for landing page)
   * URL: /api/summary/:userId
   */
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return reply.status(404).send({ error: 'Invalid user ID format' });
    }

    // Get user
    const user = await queryOne<{
      id: string;
      phone: string;
      language: string;
      name: string | null;
    }>(
      `SELECT id, phone, COALESCE(language, 'es') as language, name
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Get health summary from memories table
    let summary = null;
    try {
      summary = await queryOne<{
        content: string;
        created_at: Date;
      }>(
        `SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    } catch (err) {
      // Table may not exist yet
    }

    if (!summary) {
      return reply.status(404).send({ error: 'No summary found' });
    }

    // Also fetch concerns if table exists
    let concerns: Array<{ id: string; title: string; status: string; summaryContent: string | null; icon: string | null; updatedAt: Date }> = [];
    try {
      const concernService = new ConcernService(db);
      const allConcerns = await concernService.getAllConcerns(userId);
      concerns = allConcerns.map(c => ({
        id: c.id,
        title: c.title,
        status: c.status,
        summaryContent: c.summaryContent,
        icon: c.icon,
        updatedAt: c.updatedAt,
      }));
    } catch {
      // Table may not exist yet
    }

    return {
      userId: user.id,
      userName: user.name,
      language: user.language,
      summary: summary.content,
      updatedAt: summary.created_at,
      concerns,
    };
  });

  /**
   * Update health summary by user ID
   * URL: PUT /api/summary/:userId
   */
  app.put('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { summary } = request.body as { summary: string };

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      return reply.status(400).send({ error: 'Invalid user ID format' });
    }

    if (!summary || typeof summary !== 'string') {
      return reply.status(400).send({ error: 'Summary is required' });
    }

    // Verify user exists
    const user = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [userId]
    );

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    try {
      // Check if a health_summary already exists for this user
      const existingSummary = await queryOne<{ id: string }>(
        `SELECT id FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (existingSummary) {
        // Update existing summary
        await query(
          `UPDATE memories
           SET content = $1, created_at = NOW()
           WHERE id = $2`,
          [summary.trim(), existingSummary.id]
        );
      } else {
        // Insert new summary
        await query(
          `INSERT INTO memories (user_id, category, content, created_at)
           VALUES ($1, 'health_summary', $2, NOW())`,
          [userId, summary.trim()]
        );
      }

      return {
        success: true,
        message: 'Summary updated successfully',
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      const error = err as Error;
      console.error('Error updating summary:', error.message);
      return reply.status(500).send({ error: 'Failed to update summary' });
    }
  });

  /**
   * Get health summary for a user by phone number
   * This is the main endpoint for the website to display live summaries
   */
  app.get('/user/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string };

    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');

    // Find user by phone
    const user = await queryOne<{
      id: string;
      phone: string;
      language: string;
      created_at: Date;
    }>(
      `SELECT id, phone, COALESCE(language, 'es') as language, created_at
       FROM users
       WHERE phone = $1 OR phone = $2`,
      [phone, normalizedPhone]
    );

    if (!user) {
      throw new NotFoundError(`User not found with phone: ${phone}`);
    }

    // Get health summary (handle missing table/columns gracefully)
    let summary = null;
    try {
      summary = await queryOne<{
        content: string;
        created_at: Date;
      }>(
        `SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
    } catch (err) {
      // Table may not exist yet - that's ok
    }

    // Get conversation stats (handle missing table gracefully)
    let stats = null;
    try {
      stats = await queryOne<{
        message_count: number;
        phase: string;
      }>(
        `SELECT message_count, phase
         FROM conversation_state
         WHERE user_id = $1`,
        [user.id]
      );
    } catch (err) {
      // Table may not exist yet - that's ok
    }

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          language: user.language,
          joinedAt: user.created_at,
        },
        summary: summary ? {
          content: summary.content,
          updatedAt: summary.created_at,
          viewCount: 0,
        } : null,
        stats: stats ? {
          totalMessages: stats.message_count,
          phase: stats.phase,
        } : {
          totalMessages: 0,
          phase: 'new',
        },
      },
    };
  });

  /**
   * Get health summary by user ID (alternative lookup)
   */
  app.get('/user/id/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      throw new NotFoundError('Invalid user ID format');
    }

    // Get user
    const user = await queryOne<{
      id: string;
      phone: string;
      language: string;
      created_at: Date;
    }>(
      `SELECT id, phone, COALESCE(language, 'es') as language, created_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!user) {
      throw new NotFoundError(`User not found: ${userId}`);
    }

    // Get health summary
    let summary = null;
    try {
      summary = await queryOne<{
        content: string;
        created_at: Date;
      }>(
        `SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    } catch (err) {
      // Table may not exist
    }

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          language: user.language,
          joinedAt: user.created_at,
        },
        summary: summary ? {
          content: summary.content,
          updatedAt: summary.created_at,
        } : null,
      },
    };
  });

  /**
   * Get all users with summaries (for dashboard)
   * Returns paginated list of users with their latest summary preview
   * Optimized: Uses JOIN instead of N+1 queries
   */
  app.get('/users', async (request, reply) => {
    const queryParams = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(queryParams.limit || '20', 10), 100);
    const offset = parseInt(queryParams.offset || '0', 10);

    // Optimized: Single query with LEFT JOIN to get users and conversation stats
    const users = await queryMany<{
      id: string;
      phone: string;
      language: string;
      created_at: Date;
      message_count: number | null;
      phase: string | null;
    }>(
      `SELECT
         u.id,
         u.phone,
         COALESCE(u.preferred_language, 'es') as language,
         u.created_at,
         cs.message_count,
         cs.phase
       FROM users u
       LEFT JOIN conversation_state cs ON u.id = cs.user_id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');

    // Transform results (no additional queries needed)
    const enrichedUsers = users.map((u) => ({
      id: u.id,
      phone: u.phone,
      language: u.language,
      joinedAt: u.created_at,
      messageCount: u.message_count || 0,
      phase: u.phase || 'new',
      summaryPreview: null,
      summaryUpdatedAt: null,
    }));

    return {
      success: true,
      data: {
        users: enrichedUsers,
        pagination: {
          limit,
          offset,
          total: total?.count || 0,
        },
      },
    };
  });

  /**
   * Get conversation history for a user (for detailed view)
   */
  app.get('/user/:phone/messages', async (request, reply) => {
    const { phone } = request.params as { phone: string };
    const queryParams = request.query as { limit?: string };
    const limit = Math.min(parseInt(queryParams.limit || '50', 10), 200);

    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');

    // Find user
    const user = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE phone = $1 OR phone = $2`,
      [phone, normalizedPhone]
    );

    if (!user) {
      throw new NotFoundError(`User not found with phone: ${phone}`);
    }

    // Get messages
    let messages: Array<{ id: string; role: string; content: string; created_at: Date }> = [];
    try {
      messages = await queryMany<{
        id: string;
        role: string;
        content: string;
        created_at: Date;
      }>(
        `SELECT id, role, content, created_at
         FROM messages
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [user.id, limit]
      );
    } catch (err) {
      // Table may not exist
    }

    return {
      success: true,
      data: {
        messages: messages.reverse().map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.created_at,
        })),
      },
    };
  });
};
