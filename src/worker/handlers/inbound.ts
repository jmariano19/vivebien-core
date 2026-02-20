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

  // ── Step 3b: Check conversation phase (for name collection flow) ─────────
  const conversationState = await db.query<{ phase: string }>(
    'SELECT phase FROM conversation_state WHERE user_id = $1',
    [user.id],
  );
  const currentPhase = conversationState.rows[0]?.phase || 'onboarding';

  // ── NEW USER: Send welcome + ask for name ────────────────────────────────
  if (user.isNew) {
    logger.info({ userId: user.id }, 'New user — sending welcome and asking for name');

    // Send single combined welcome + name question (avoids message ordering issues)
    const welcomeMessages: Record<string, string> = {
      es: 'Hola 👋\nEstoy aquí para ayudarte a entender qué hacer con lo que ya tienes en tu cocina.\n\nAquí no te voy a señalar lo que hiciste mal.\nTampoco te voy a dar una dieta.\nSolo vamos a mirar tu día con calma y entender qué pasó en tu cuerpo.\nSin juicio. Sin presión.\n\nExplícame qué estás comiendo hoy — o mándame una foto.\n\n¿Cómo te llamas? Así lo hacemos personal.',
      en: 'Hello 👋\nI\'m here to help you make the most of what you already have in your kitchen.\n\nI\'m not going to point out what you did wrong.\nI\'m not going to give you a diet.\nWe\'re just going to look at your day calmly and understand what happened in your body.\nNo judgment. No pressure.\n\nTell me what you\'re eating today — or send me a photo.\n\nWhat\'s your name? So we can make it personal.',
      pt: 'Olá 👋\nEstou aqui para te ajudar a aproveitar o que você já tem na cozinha.\n\nAqui não vou te apontar o que fez de errado.\nTambém não vou te dar uma dieta.\nSó vamos olhar seu dia com calma e entender o que aconteceu no seu corpo.\nSem julgamento. Sem pressão.\n\nMe conta o que está comendo hoje — ou manda uma foto.\n\nQual é o seu nome? Assim personalizamos tudo.',
      fr: 'Bonjour 👋\nJe suis là pour vous aider à tirer le meilleur de ce que vous avez déjà dans votre cuisine.\n\nIci, je ne vais pas pointer ce que vous avez mal fait.\nJe ne vais pas non plus vous donner un régime.\nOn va simplement regarder votre journée calmement et comprendre ce qui s\'est passé dans votre corps.\nSans jugement. Sans pression.\n\nDites-moi ce que vous mangez aujourd\'hui — ou envoyez-moi une photo.\n\nComment vous appelez-vous? Pour personnaliser votre expérience.',
    };

    const lang = user.language || 'es';
    const welcome = welcomeMessages[lang] || welcomeMessages.es!;

    // Single message — no ordering issues
    await chatwootClient.sendMessage(conversationId, welcome);
    markResponseSent();

    // Update phase to awaiting_name
    await db.query(
      `UPDATE conversation_state SET phase = 'awaiting_name' WHERE user_id = $1`,
      [user.id],
    );

    // Still save the health event (their first message might have food info)
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
      action: 'welcome_sent_awaiting_name',
    };
  }

  // ── AWAITING NAME: Capture the user's name ───────────────────────────────
  if (currentPhase === 'awaiting_name') {
    const rawName = extractName(processedMessage);
    logger.info({ userId: user.id, rawName }, 'Capturing user name');

    if (rawName) {
      // Save name to user record
      await userService.updateName(user.id, rawName);

      // Update phase to active
      await db.query(
        `UPDATE conversation_state SET phase = 'active' WHERE user_id = $1`,
        [user.id],
      );

      // Send personalized confirmation (short — welcome already gave food prompt)
      const confirmMessages: Record<string, string> = {
        es: `¡Mucho gusto, ${rawName}! 🙌 Listo, vamos.`,
        en: `Nice to meet you, ${rawName}! 🙌 Let's go.`,
        pt: `Prazer, ${rawName}! 🙌 Vamos lá.`,
        fr: `Enchanté, ${rawName}! 🙌 C'est parti.`,
      };

      const lang = user.language || 'es';
      await chatwootClient.sendMessage(
        conversationId,
        confirmMessages[lang] || confirmMessages.es!,
      );
      markResponseSent();

      logger.info({ userId: user.id, name: rawName }, 'Name saved, phase set to active');

      return {
        status: 'completed',
        correlationId,
        action: 'name_captured',
      };
    } else {
      // Couldn't extract a name — skip and move to active phase
      // Their message is probably food info, treat it normally
      await db.query(
        `UPDATE conversation_state SET phase = 'active' WHERE user_id = $1`,
        [user.id],
      );
      logger.info({ userId: user.id }, 'Could not extract name, moving to active phase');
      // Fall through to normal processing below
    }
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
  const hasImage = !!imageUrl;
  const ackMessage = await getSmartAck(processedMessage, user.language, questionDetected, hasImage);

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
// Name Extraction Helper
// ============================================================================

/**
 * Extract a name from the user's response.
 * Handles common patterns like:
 *   - "Maria" (just the name)
 *   - "Me llamo Maria"
 *   - "My name is Maria"
 *   - "Soy Maria"
 *   - "Maria Garcia" (first + last)
 *
 * Returns null if the message doesn't look like a name
 * (e.g., it's food info, a question, etc.)
 */
function extractName(message: string): string | null {
  const trimmed = message.trim();

  // Skip if empty or too long (probably not a name)
  if (!trimmed || trimmed.length > 100) return null;

  // Skip if it looks like food/health info (contains common food words or is very long)
  const foodIndicators = [
    'comí', 'comiste', 'desayuno', 'almuerzo', 'cena', 'arroz', 'pollo',
    'breakfast', 'lunch', 'dinner', 'ate', 'eating', 'food', 'hungry',
    'dolor', 'pain', 'headache', 'stomach', 'foto', 'photo', 'image',
    'tengo', 'i have', 'nevera', 'fridge', 'cocina', 'kitchen',
  ];

  const lower = trimmed.toLowerCase();
  if (foodIndicators.some(word => lower.includes(word))) {
    return null;
  }

  // Skip if it's a question
  if (trimmed.includes('?')) return null;

  // Try common name patterns
  const patterns = [
    /^(?:me llamo|mi nombre es|soy|i'm|i am|my name is|meu nome é|eu sou|je m'appelle|je suis)\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return cleanName(match[1]);
    }
  }

  // If it's short (1-3 words) and doesn't have numbers, treat it as a name
  const words = trimmed.split(/\s+/);
  if (words.length <= 3 && !/\d/.test(trimmed) && trimmed.length <= 50) {
    return cleanName(trimmed);
  }

  return null;
}

/**
 * Clean and capitalize a name string.
 */
function cleanName(raw: string): string {
  return raw
    .replace(/[.!,;:'"]+$/g, '') // Remove trailing punctuation
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
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
