import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { addInboundJob } from '../../infra/queue/client';
import { checkIdempotencyKey, setIdempotencyKey } from '../../infra/db/client';
import { ChatwootWebhookPayload, InboundJobData } from '../../shared/types';
import { BadRequestError } from '../../shared/errors';

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
  // Main webhook endpoint for Chatwoot
  app.post('/ingest/chatwoot', async (request, reply) => {
    const correlationId = request.id;

    // Parse and validate payload
    const parseResult = chatwootWebhookSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new BadRequestError(`Invalid webhook payload: ${parseResult.error.message}`);
    }

    const payload = parseResult.data as ChatwootWebhookPayload;

    // Only process incoming messages
    if (payload.event !== 'message_created' || payload.message_type !== 'incoming') {
      request.log.debug({ event: payload.event, type: payload.message_type }, 'Ignoring non-message event');
      return {
        success: true,
        correlationId,
        action: 'ignored',
        reason: 'Not an incoming message',
      };
    }

    // Skip if no content and no attachments
    if (!payload.content && (!payload.attachments || payload.attachments.length === 0)) {
      request.log.debug('Ignoring empty message');
      return {
        success: true,
        correlationId,
        action: 'ignored',
        reason: 'Empty message',
      };
    }

    // Check idempotency (prevent duplicate processing)
    const idempotencyKey = `chatwoot:${payload.conversation.id}:${correlationId}`;
    const existingResult = await checkIdempotencyKey(idempotencyKey);
    if (existingResult) {
      request.log.info({ idempotencyKey }, 'Duplicate request detected');
      return {
        success: true,
        correlationId,
        action: 'duplicate',
        cached: existingResult,
      };
    }

    // Extract phone number from sender (WhatsApp format: +1234567890)
    // Try phone_number first, then identifier (e.g., "12017370113@s.whatsapp.net")
    const rawPhone = payload.sender?.phone_number
      || payload.sender?.identifier?.split('@')[0]
      || '';
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      throw new BadRequestError('Invalid phone number in webhook');
    }

    // Map attachments
    const attachments = payload.attachments?.map((a) => ({
      type: mapFileType(a.file_type),
      url: a.data_url,
    }));

    // Build job data
    const jobData: InboundJobData = {
      type: 'inbound_message',
      correlationId,
      phone,
      message: payload.content || '',
      conversationId: payload.conversation.id,
      chatwootContactId: payload.sender?.id || 0,
      attachments,
      timestamp: new Date().toISOString(),
    };

    // Add to queue
    const jobId = await addInboundJob(jobData);

    // Store idempotency key
    const result = { success: true, correlationId, jobId };
    await setIdempotencyKey(idempotencyKey, result);

    request.log.info({ jobId, phone, conversationId: payload.conversation.id }, 'Message queued');

    // Return 202 Accepted (async processing)
    reply.status(202);
    return result;
  });
};

// ============================================================================
// Helper Functions
// ============================================================================

function normalizePhone(input: string): string | null {
  // Remove all non-digit characters except leading +
  let phone = input.replace(/[^\d+]/g, '');

  // Ensure it starts with +
  if (!phone.startsWith('+')) {
    // Assume it's a local number, add default country code
    // You may want to configure this based on your target market
    phone = '+' + phone;
  }

  // Basic validation: at least 10 digits
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  return phone;
}

function mapFileType(fileType: string): 'audio' | 'image' | 'video' | 'document' {
  const type = fileType.toLowerCase();

  if (type.includes('audio') || type.includes('voice') || type.includes('ogg')) {
    return 'audio';
  }
  if (type.includes('image') || type.includes('photo')) {
    return 'image';
  }
  if (type.includes('video')) {
    return 'video';
  }

  return 'document';
}
