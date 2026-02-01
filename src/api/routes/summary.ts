import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query, queryOne, queryMany } from '../../infra/db/client';
import { NotFoundError } from '../../shared/errors';

export const summaryRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // ============================================================================
  // Health Summary Endpoints (for website integration)
  // ============================================================================

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
      last_message_at: Date | null;
    }>(
      `SELECT id, phone, language, created_at, last_message_at
       FROM users
       WHERE phone = $1 OR phone = $2`,
      [phone, normalizedPhone]
    );

    if (!user) {
      throw new NotFoundError(`User not found with phone: ${phone}`);
    }

    // Get health summary
    const summary = await queryOne<{
      content: string;
      created_at: Date;
      access_count: number;
    }>(
      `SELECT content, created_at, access_count
       FROM memories
       WHERE user_id = $1 AND category = 'health_summary'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );

    // Get conversation stats
    const stats = await queryOne<{
      message_count: number;
      phase: string;
    }>(
      `SELECT message_count, phase
       FROM conversation_state
       WHERE user_id = $1`,
      [user.id]
    );

    // Update access count for analytics
    if (summary) {
      await query(
        `UPDATE memories SET access_count = access_count + 1, last_accessed_at = NOW()
         WHERE user_id = $1 AND category = 'health_summary'`,
        [user.id]
      );
    }

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          language: user.language,
          joinedAt: user.created_at,
          lastActiveAt: user.last_message_at,
        },
        summary: summary ? {
          content: summary.content,
          updatedAt: summary.created_at,
          viewCount: summary.access_count,
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
      last_message_at: Date | null;
    }>(
      `SELECT id, phone, language, created_at, last_message_at
       FROM users
       WHERE id = $1`,
      [userId]
    );

    if (!user) {
      throw new NotFoundError(`User not found: ${userId}`);
    }

    // Get health summary
    const summary = await queryOne<{
      content: string;
      created_at: Date;
    }>(
      `SELECT content, created_at
       FROM memories
       WHERE user_id = $1 AND category = 'health_summary'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          phone: user.phone,
          language: user.language,
          joinedAt: user.created_at,
          lastActiveAt: user.last_message_at,
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
   */
  app.get('/users', async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const users = await queryMany<{
      id: string;
      phone: string;
      language: string;
      created_at: Date;
      last_message_at: Date | null;
      message_count: number;
      phase: string;
      summary_preview: string | null;
      summary_updated_at: Date | null;
    }>(
      `SELECT
         u.id,
         u.phone,
         u.language,
         u.created_at,
         u.last_message_at,
         COALESCE(cs.message_count, 0) as message_count,
         COALESCE(cs.phase, 'new') as phase,
         LEFT(m.content, 200) as summary_preview,
         m.created_at as summary_updated_at
       FROM users u
       LEFT JOIN conversation_state cs ON cs.user_id = u.id
       LEFT JOIN memories m ON m.user_id = u.id AND m.category = 'health_summary'
       ORDER BY u.last_message_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');

    return {
      success: true,
      data: {
        users: users.map(u => ({
          id: u.id,
          phone: u.phone,
          language: u.language,
          joinedAt: u.created_at,
          lastActiveAt: u.last_message_at,
          messageCount: u.message_count,
          phase: u.phase,
          summaryPreview: u.summary_preview,
          summaryUpdatedAt: u.summary_updated_at,
        })),
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
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);

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
    const messages = await queryMany<{
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
