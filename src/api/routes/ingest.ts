import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { addInboundJob } from '../../infra/queue/client';
import { checkIdempotencyKey, setIdempotencyKey } from '../../infra/db/client';
import { InboundJobData, Attachment } from '../../shared/types';

// Helper to normalize phone numbers
function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

// Helper to map file types to attachment types
function mapFileType(fileType: string): Attachment['type'] {
  if (fileType.startsWith('audio')) return 'audio';
  if (fileType.startsWith('image')) return 'image';
  if (fileType.startsWith('video')) return 'video';
  return 'document';
}

// Type for Chatwoot webhook payload (flexible to handle variations)
interface ChatwootWebhook {
  event?: string;
  message_type?: string;
  content?: string;
  content_type?: string;
  conversation?: {
    id?: number;
    contact_inbox?: {
      source_id?: string;
    };
    meta?: {
      sender?: {
        name?: string;
        phone_number?: string;
        identifier?: string;
      };
    };
  };
  sender?: {
    id?: number;
    name?: string;
    phone_number?: string;
    identifier?: string;
  };
  attachments?: Array<{
    file_type?: string;
    data_url?: string;
  }>;
}

export const ingestRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Main Chatwoot webhook endpoint
  app.post('/ingest/chatwoot', async (request, reply) => {
    const correlationId = request.id;
    const payload = request.body as ChatwootWebhook;

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

    const isDuplicate = await checkIdempotencyKey(idempotencyKey);
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
    const attachments: Attachment[] = [];
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
    const jobData: InboundJobData = {
      type: 'inbound_message',
      correlationId,
      phone,
      message: payload.content || '',
      conversationId,
      chatwootContactId: payload.sender?.id || 0,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: new Date().toISOString(),
    };

    await addInboundJob(jobData);
    await setIdempotencyKey(idempotencyKey, { status: 'queued' }, 24);

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
      payload: request.body as Record<string, unknown>,
      headers: request.headers as Record<string, string>,
    });
    return reply.status(res.statusCode).send(res.json());
  });
};
