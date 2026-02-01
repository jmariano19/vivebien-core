import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addInboundJob } from '../../infra/queue/client';
import { checkIdempotencyKey, setIdempotencyKey } from '../../infra/db/client';
import { ChatwootWebhookPayload, InboundJobData } from '../../shared/types';
import { BadRequestError } from '../../shared/errors';

// Helper to normalize phone numbers
function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

// Validation schema for Chatwoot webhook
const chatwootWebhookSchema = z.object({
  event: z.string(),
  message_type: z.enum(['incoming', 'outgoing']),
  content: z.string().optional(),
  conversation: z.object({
    id: z.number(),
    contact_inbox: z.object({
      source_id: z.string(),
    }),
    meta: z.object({
      sender: z.object({
        name: z.string().optional(),
      }).optional(),
    }).optional(),
  }),
  sender: z.object({
    id: z.number(),
    name: z.string().optional(),
    phone_number: z.string().optional(),
    identifier: z.string().optional(),
  }).optional(),
  attachments: z.array(z.object({
    file_type: z.string(),
    data_url: z.string(),
  })).optional(),
});

export const ingestRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/ingest/chatwoot', async (request, reply) => {
    const correlationId = request.id;
    app.log.info({ correlationId, body: request.body }, 'Received Chatwoot webhook');

    const parseResult = chatwootWebhookSchema.safeParse(request.body);
    if (!parseResult.success) {
      app.log.warn({ correlationId, errors: parseResult.error.errors }, 'Invalid webhook payload');
      throw new BadRequestError('Invalid webhook payload');
    }

    const payload = parseResult.data;

    if (payload.message_type !== 'incoming') {
      app.log.info({ correlationId }, 'Skipping non-incoming message');
      return { status: 'skipped', reason: 'not incoming message' };
    }

    const idempotencyKey = `chatwoot:${payload.conversation.id}:${Date.now()}`;

    const isDuplicate = await checkIdempotencyKey(idempotencyKey);
    if (isDuplicate) {
      app.log.info({ correlationId, idempotencyKey }, 'Duplicate message, skipping');
      return { status: 'skipped', reason: 'duplicate' };
    }

    // Extract phone from sender (Chatwoot sends it here for WhatsApp)
    const rawPhone = payload.sender?.phone_number
      || payload.sender?.identifier?.split('@')[0]
      || '';
    const phone = normalizePhone(rawPhone);

    if (!phone || phone.length < 10) {
      app.log.warn({ correlationId, rawPhone, sender: payload.sender }, 'Invalid phone number in webhook');
      throw new BadRequestError('Invalid phone number in webhook');
    }

    const jobData: InboundJobData = {
      correlationId,
      phone,
      message: payload.content || '',
      conversationId: payload.conversation.id,
      senderName: payload.conversation.meta?.sender?.name || payload.sender?.name || 'Unknown',
      attachments: payload.attachments?.map(a => ({
        type: a.file_type,
        url: a.data_url,
      })) || [],
      timestamp: new Date().toISOString(),
    };

    await addInboundJob(jobData);
    await setIdempotencyKey(idempotencyKey);

    app.log.info({ correlationId, phone, conversationId: payload.conversation.id }, 'Message queued successfully');

    return { status: 'queued', correlationId };
  });
};
