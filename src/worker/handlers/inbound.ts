/**
 * Plato Inteligente — Inbound Message Handler
 *
 * Simplified flow: NO AI calls during the day.
 *   1. Load/create user
 *   2. Transcribe voice (Whisper) if needed
 *   3. Detect & update language
 *   4. Safety check (rule-based crisis keywords)
 *   5. Detect if it's a question
 *   6. Save raw input to health_events (processed=FALSE)
 *   7. Send template ack via Chatwoot
 *
 * All intelligence is concentrated in the nightly pipeline.
 */

import { Logger } from 'pino';
import { InboundJobData, JobResult } from '../../shared/types';
import { UserService } from '../../domain/user/service';
import { HealthEventService } from '../../domain/health-event/service';
import { mediaService } from '../../domain/media/service';
import { ConversationService } from '../../domain/conversation/service';
import { ChatwootClient } from '../../adapters/chatwoot/client';
import { db } from '../../infra/db/client';
import { logExecution } from '../../infra/logging/logger';
import { detectLanguage } from '../../shared/language';
import { isQuestion, getSmartAck } from '../../shared/ack-messages';

const userService = new UserService(db);
const healthEventService = new HealthEventService(db);
const conversationService = new ConversationService(db);
const chatwootClient = new ChatwootClient();

export async function handleInboundMessage(
  data: InboundJobData,
  logger: Logger
): Promise<JobResult> {
  const { correlationId, conversationId } = data;
  let responseSent = false;

  try {
    return await _handleInboundMessage(data, logger, () => { responseSent = true; });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({
      correlationId,
      conversationId,
      error: err.message,
      stack: err.stack,
    }, 'Unhandled error in message processing — sending fallback response');

    if (!responseSent) {
      try {
        const detectedLang = detectLanguage(data.message) || 'es';
        const fallbackMessages: Record<string, string> = {
          es: 'Lo siento, tuve un problema temporal. ¿Podrías intentar enviarlo de nuevo?',
          en: "Sorry, I had a temporary issue. Could you try sending it again?",
          pt: 'Desculpe, tive um problema temporário. Poderia tentar novamente?',
          fr: "Désolé, j'ai eu un problème temporaire. Pourriez-vous réessayer?",
        };
        await chatwootClient.sendMessage(conversationId, fallbackMessages[detectedLang] || fallbackMessages.es!);
      } catch (sendErr) {
        logger.error({ correlationId, error: sendErr }, 'Failed to send fallback message');
      }
    }

    return {
      status: 'failed' as const,
      correlationId,
      error: err.message,
    };
  }
}

async function _handleInboundMessage(
  data: InboundJobData,
  logger: Logger,
  markResponseSent: () => void,
): Promise<JobResult> {
  const { correlationId, phone, message, conversationId, attachments } = data;

  // ── Step 1: Load or create user ──────────────────────────────────────────
  const user = await logExecution(
    correlationId,
    'load_user',
    async () => userService.loadOrCreate(phone),
    logger,
  );

  logger.info({ userId: user.id, isNew: user.isNew }, 'User loaded');

  // ── Step 2: Transcribe voice messages (Whisper — only AI call during day) ─
  let processedMessage = message;
  let imageUrl: string | null = null;

  if (attachments && attachments.length > 0) {
    processedMessage = await logExecution(
      correlationId,
      'process_media',
      async () => processAttachments(attachments, message, user.language || 'es', logger),
      logger,
    );

    // Capture image URL for health_events
    const imageAttachment = attachments.find(a => a.type === 'image');
    if (imageAttachment) {
      imageUrl = imageAttachment.url;
    }
  }

  // ── Step 3: Detect & update language (always — user may switch languages) ─
  const detectedLang = detectLanguage(processedMessage);
  if (detectedLang && detectedLang !== user.language) {
    await logExecution(
      correlationId,
      'update_language',
      async () => userService.updateLanguage(user.id, detectedLang),
      logger,
    );
    user.language = detectedLang;
    logger.info({ userId: user.id, language: detectedLang }, 'Language updated');
  }

  // ── Step 4: Safety check (crisis keywords — no AI) ───────────────────────
  const safetyCheck = await logExecution(
    correlationId,
    'safety_check',
    async () => conversationService.checkSafety(processedMessage, {
      userId: user.id,
      conversationId,
      phase: 'active',
      messageCount: 0,
      promptVersion: '',
      experimentVariants: {},
      metadata: {},
    }),
    logger,
  );

  if (safetyCheck.isUrgent) {
    logger.warn({ userId: user.id, type: safetyCheck.type }, 'Crisis message detected');

    // For crisis messages, still save the event, but also send crisis resources
    const crisisMessages: Record<string, string> = {
      es: 'Tu mensaje es importante para nosotros. Si estás en crisis, por favor llama a la Línea Nacional 800-290-0024 o Línea de la Vida 800-911-2000. Estamos aquí contigo.',
      en: 'Your message matters to us. If you\'re in crisis, please call 988 (Suicide & Crisis Lifeline). We\'re here with you.',
      pt: 'Sua mensagem é importante para nós. Se estiver em crise, ligue para o CVV 188. Estamos aqui com você.',
      fr: 'Votre message est important pour nous. Si vous êtes en crise, appelez le 3114. Nous sommes avec vous.',
    };

    await chatwootClient.sendMessage(
      conversationId,
      crisisMessages[user.language] || crisisMessages.es!,
    );
    markResponseSent();

    // Save the event anyway (for the nightly pipeline to see context)
    await healthEventService.saveEvent({
      userId: user.id,
      rawInput: processedMessage,
      imageUrl,
      language: user.language,
      isQuestion: false,
      source: 'whatsapp',
    });

    return {
      status: 'completed',
      correlationId,
      action: 'crisis_response_sent',
    };
  }

  // ── Step 5: Detect if it's a question ────────────────────────────────────
  const questionDetected = isQuestion(processedMessage);

  // ── Step 6: Save to health_events (raw, unprocessed) ─────────────────────
  const event = await logExecution(
    correlationId,
    'save_health_event',
    async () => healthEventService.saveEvent({
      userId: user.id,
      rawInput: processedMessage,
      imageUrl,
      language: user.language,
      isQuestion: questionDetected,
      source: 'whatsapp',
    }),
    logger,
  );

  logger.info(
    { eventId: event.id, userId: user.id, isQuestion: questionDetected },
    'Health event saved',
  );

  // ── Step 7: Send smart ack (Haiku — mirrors the user's message) ─────────
  const ackMessage = await getSmartAck(processedMessage, user.language, questionDetected);

  await logExecution(
    correlationId,
    'send_ack',
    async () => chatwootClient.sendMessage(conversationId, ackMessage),
    logger,
  );
  markResponseSent();

  logger.info(
    { userId: user.id, ack: ackMessage, isQuestion: questionDetected },
    'Ack sent',
  );

  return {
    status: 'completed',
    correlationId,
    action: questionDetected ? 'question_acked' : 'input_acked',
  };
}

// ============================================================================
// Media Processing (voice → Whisper transcription, images → save URL only)
// ============================================================================

async function processAttachments(
  attachments: Array<{ type: string; url: string }>,
  originalMessage: string,
  language: string,
  logger: Logger,
): Promise<string> {
  const parts: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'audio') {
      // Voice messages: transcribe with Whisper (only external call during the day)
      logger.info({ url: attachment.url }, 'Transcribing voice message');
      const transcription = await mediaService.transcribeAudio(attachment.url, language);
      if (transcription && !transcription.startsWith('[')) {
        parts.push(`[Voice message]: ${transcription}`);
      } else {
        parts.push(transcription);
      }
    } else if (attachment.type === 'image') {
      // Images: just note that an image was sent. NO Vision call.
      // The nightly pipeline will analyze images in batch.
      parts.push('[Image attached]');
      logger.info({ url: attachment.url }, 'Image attachment noted (deferred to nightly)');
    }
  }

  if (originalMessage) {
    parts.unshift(originalMessage);
  }

  return parts.join('\n');
}
