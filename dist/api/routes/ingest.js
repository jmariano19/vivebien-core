"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestRoutes = void 0;
const client_1 = require("../../infra/queue/client");
const client_2 = require("../../infra/db/client");
const auth_1 = require("../middleware/auth");
// Helper to normalize phone numbers
function normalizePhone(raw) {
    const digits = raw.replace(/[^\d+]/g, '');
    return digits.startsWith('+') ? digits : `+${digits}`;
}
// Helper to map file types to attachment types
function mapFileType(fileType) {
    if (fileType.startsWith('audio'))
        return 'audio';
    if (fileType.startsWith('image'))
        return 'image';
    if (fileType.startsWith('video'))
        return 'video';
    return 'document';
}
const ingestRateLimit = (0, auth_1.rateLimit)({ windowMs: 60_000, maxRequests: 120 });
const ingestRoutes = async (app) => {
    // Main Chatwoot webhook endpoint
    app.post('/ingest/chatwoot', { preHandler: ingestRateLimit }, async (request, reply) => {
        const correlationId = request.id;
        const payload = request.body;
        app.log.info({
            correlationId,
            event: payload.event,
            message_type: payload.message_type,
            hasContent: !!payload.content,
            hasAttachments: !!(payload.attachments && payload.attachments.length > 0),
            conversationId: payload.conversation?.id,
        }, 'Received Chatwoot webhook');
        // Skip non-message events
        if (payload.event !== 'message_created') {
            app.log.info({ correlationId, event: payload.event }, 'Skipping non-message event');
            return { status: 'skipped', reason: 'not a message event' };
        }
        // Skip outgoing messages (from bot/agent)
        if (payload.message_type !== 'incoming') {
            app.log.info({ correlationId, message_type: payload.message_type }, 'Skipping non-incoming message');
            return { status: 'skipped', reason: 'not incoming message' };
        }
        // Validate conversation ID
        const conversationId = payload.conversation?.id;
        if (!conversationId) {
            app.log.warn({ correlationId, payload }, 'Missing conversation ID');
            return { status: 'error', reason: 'missing conversation id' };
        }
        const idempotencyKey = `chatwoot:${conversationId}:${Date.now()}`;
        const isDuplicate = await (0, client_2.checkIdempotencyKey)(idempotencyKey);
        if (isDuplicate) {
            app.log.info({ correlationId, idempotencyKey }, 'Duplicate message, skipping');
            return { status: 'skipped', reason: 'duplicate' };
        }
        // Extract phone from multiple possible locations
        const rawPhone = payload.sender?.phone_number
            || payload.sender?.identifier?.split('@')[0]
            || payload.conversation?.meta?.sender?.phone_number
            || payload.conversation?.meta?.sender?.identifier?.split('@')[0]
            || payload.conversation?.contact_inbox?.source_id?.split('@')[0]
            || '';
        const phone = normalizePhone(rawPhone);
        if (!phone || phone.length < 10) {
            app.log.warn({
                correlationId,
                rawPhone,
                sender: payload.sender,
                conversationMeta: payload.conversation?.meta,
                contactInbox: payload.conversation?.contact_inbox,
            }, 'Invalid phone number in webhook');
            return { status: 'error', reason: 'invalid phone number' };
        }
        // Process attachments
        const attachments = [];
        if (payload.attachments && payload.attachments.length > 0) {
            for (const att of payload.attachments) {
                if (att.file_type && att.data_url) {
                    attachments.push({
                        type: mapFileType(att.file_type),
                        url: att.data_url,
                    });
                }
            }
        }
        // Build job data
        const jobData = {
            type: 'inbound_message',
            correlationId,
            phone,
            message: payload.content || '',
            conversationId,
            chatwootContactId: payload.sender?.id || 0,
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp: new Date().toISOString(),
        };
        try {
            await (0, client_1.addInboundJob)(jobData);
            await (0, client_2.setIdempotencyKey)(idempotencyKey, { status: 'queued' }, 24);
        }
        catch (err) {
            app.log.error({ err, correlationId, phone }, 'Failed to queue inbound job');
            return reply.status(500).send({ status: 'error', reason: 'failed to queue message' });
        }
        app.log.info({
            correlationId,
            phone,
            conversationId,
            messageLength: payload.content?.length || 0,
            attachmentCount: attachments.length,
        }, 'Message queued successfully');
        return { status: 'queued', correlationId };
    });
    // Also support /api/ingest for backwards compatibility
    app.post('/api/ingest', async (request, reply) => {
        // Forward to the main handler
        const res = await app.inject({
            method: 'POST',
            url: '/ingest/chatwoot',
            payload: request.body,
            headers: request.headers,
        });
        return reply.status(res.statusCode).send(res.json());
    });
};
exports.ingestRoutes = ingestRoutes;
//# sourceMappingURL=ingest.js.map