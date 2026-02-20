"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summaryRoutes = void 0;
const client_1 = require("../../infra/db/client");
const errors_1 = require("../../shared/errors");
const service_1 = require("../../domain/concern/service");
const summaryRoutes = async (app) => {
    // ============================================================================
    // Health Summary Endpoints (for website integration)
    // ============================================================================
    /**
     * Get health summary by user ID (simple endpoint for landing page)
     * URL: /api/summary/:userId
     */
    app.get('/:userId', async (request, reply) => {
        const { userId } = request.params;
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(userId)) {
            return reply.status(404).send({ error: 'Invalid user ID format' });
        }
        // Get user
        const user = await (0, client_1.queryOne)(`SELECT id, phone, COALESCE(language, 'es') as language, name
       FROM users
       WHERE id = $1`, [userId]);
        if (!user) {
            return reply.status(404).send({ error: 'User not found' });
        }
        // Get health summary from memories table
        let summary = null;
        try {
            summary = await (0, client_1.queryOne)(`SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`, [userId]);
        }
        catch (err) {
            request.log.debug({ err, userId }, 'Could not fetch from memories table');
        }
        if (!summary) {
            return reply.status(404).send({ error: 'No summary found' });
        }
        // Also fetch concerns if table exists
        let concerns = [];
        try {
            const concernService = new service_1.ConcernService(client_1.db);
            const allConcerns = await concernService.getAllConcerns(userId);
            concerns = allConcerns.map(c => ({
                id: c.id,
                title: c.title,
                status: c.status,
                summaryContent: c.summaryContent,
                icon: c.icon,
                updatedAt: c.updatedAt,
            }));
        }
        catch (err) {
            request.log.debug({ err, userId }, 'Could not fetch concerns');
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
        const { userId } = request.params;
        const { summary } = request.body;
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(userId)) {
            return reply.status(400).send({ error: 'Invalid user ID format' });
        }
        if (!summary || typeof summary !== 'string') {
            return reply.status(400).send({ error: 'Summary is required' });
        }
        // Verify user exists
        const user = await (0, client_1.queryOne)(`SELECT id FROM users WHERE id = $1`, [userId]);
        if (!user) {
            return reply.status(404).send({ error: 'User not found' });
        }
        try {
            // Check if a health_summary already exists for this user
            const existingSummary = await (0, client_1.queryOne)(`SELECT id FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`, [userId]);
            if (existingSummary) {
                // Update existing summary
                await (0, client_1.query)(`UPDATE memories
           SET content = $1, created_at = NOW()
           WHERE id = $2`, [summary.trim(), existingSummary.id]);
            }
            else {
                // Insert new summary
                await (0, client_1.query)(`INSERT INTO memories (user_id, category, content, created_at)
           VALUES ($1, 'health_summary', $2, NOW())`, [userId, summary.trim()]);
            }
            return {
                success: true,
                message: 'Summary updated successfully',
                updatedAt: new Date().toISOString(),
            };
        }
        catch (err) {
            request.log.error({ err, userId }, 'Error updating summary');
            return reply.status(500).send({ error: 'Failed to update summary' });
        }
    });
    /**
     * Get health summary for a user by phone number
     * This is the main endpoint for the website to display live summaries
     */
    app.get('/user/:phone', async (request, reply) => {
        const { phone } = request.params;
        // Normalize phone number (remove spaces, dashes, etc.)
        const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
        // Find user by phone
        const user = await (0, client_1.queryOne)(`SELECT id, phone, COALESCE(language, 'es') as language, created_at
       FROM users
       WHERE phone = $1 OR phone = $2`, [phone, normalizedPhone]);
        if (!user) {
            throw new errors_1.NotFoundError('User not found');
        }
        // Get health summary (handle missing table/columns gracefully)
        let summary = null;
        try {
            summary = await (0, client_1.queryOne)(`SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`, [user.id]);
        }
        catch (err) {
            request.log.debug({ err, userId: user.id }, 'Could not fetch memories');
        }
        // Get conversation stats (handle missing table gracefully)
        let stats = null;
        try {
            stats = await (0, client_1.queryOne)(`SELECT message_count, phase
         FROM conversation_state
         WHERE user_id = $1`, [user.id]);
        }
        catch (err) {
            request.log.debug({ err, userId: user.id }, 'Could not fetch conversation_state');
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
        const { userId } = request.params;
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(userId)) {
            throw new errors_1.NotFoundError('Invalid user ID format');
        }
        // Get user
        const user = await (0, client_1.queryOne)(`SELECT id, phone, COALESCE(language, 'es') as language, created_at
       FROM users
       WHERE id = $1`, [userId]);
        if (!user) {
            throw new errors_1.NotFoundError(`User not found: ${userId}`);
        }
        // Get health summary
        let summary = null;
        try {
            summary = await (0, client_1.queryOne)(`SELECT content, created_at
         FROM memories
         WHERE user_id = $1 AND category = 'health_summary'
         ORDER BY created_at DESC LIMIT 1`, [userId]);
        }
        catch (err) {
            request.log.debug({ err, userId }, 'Could not fetch memories');
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
        const queryParams = request.query;
        const limit = Math.min(parseInt(queryParams.limit || '20', 10), 100);
        const offset = parseInt(queryParams.offset || '0', 10);
        // Optimized: Single query with LEFT JOIN to get users and conversation stats
        const users = await (0, client_1.queryMany)(`SELECT
         u.id,
         u.phone,
         COALESCE(u.preferred_language, 'es') as language,
         u.created_at,
         cs.message_count,
         cs.phase
       FROM users u
       LEFT JOIN conversation_state cs ON u.id = cs.user_id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`, [limit, offset]);
        const total = await (0, client_1.queryOne)('SELECT COUNT(*) as count FROM users');
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
        const { phone } = request.params;
        const queryParams = request.query;
        const limit = Math.min(parseInt(queryParams.limit || '50', 10), 200);
        const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
        // Find user
        const user = await (0, client_1.queryOne)(`SELECT id FROM users WHERE phone = $1 OR phone = $2`, [phone, normalizedPhone]);
        if (!user) {
            throw new errors_1.NotFoundError('User not found');
        }
        // Get messages
        let messages = [];
        try {
            messages = await (0, client_1.queryMany)(`SELECT id, role, content, created_at
         FROM messages
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`, [user.id, limit]);
        }
        catch (err) {
            request.log.debug({ err, userId: user.id }, 'Could not fetch messages');
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
exports.summaryRoutes = summaryRoutes;
//# sourceMappingURL=summary.js.map