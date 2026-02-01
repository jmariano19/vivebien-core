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
   */
  app.get('/users', async (request, reply) => {
    const queryParams = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(queryParams.limit || '20', 10), 100);
    const offset = parseInt(queryParams.offset || '0', 10);

    // Simple query first - just get users
    const users = await queryMany<{
      id: string;
      phone: string;
      language: string;
      created_at: Date;
    }>(
      `SELECT
         id,
         phone,
         COALESCE(language, 'es') as language,
         created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');

    // Enrich with conversation state if available
    const enrichedUsers = await Promise.all(users.map(async (u) => {
      let messageCount = 0;
      let phase = 'new';

      try {
        const stats = await queryOne<{ message_count: number; phase: string }>(
          `SELECT message_count, phase FROM conversation_state WHERE user_id = $1`,
          [u.id]
        );
        if (stats) {
          messageCount = stats.message_count;
          phase = stats.phase;
        }
      } catch (err) {
        // Table may not exist
      }

      return {
        id: u.id,
        phone: u.phone,
        language: u.language,
        joinedAt: u.created_at,
        messageCount,
        phase,
        summaryPreview: null,
        summaryUpdatedAt: null,
      };
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
