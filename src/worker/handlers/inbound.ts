import { Logger } from 'pino';
import { InboundJobData, JobResult, ConversationContext, Message } from '../../shared/types';
import { UserService } from '../../domain/user/service';
import { CreditService } from '../../domain/credits/service';
import { ConversationService } from '../../domain/conversation/service';
import { AIService } from '../../domain/ai/service';
import { CheckinService } from '../../domain/checkin/service';
import { mediaService } from '../../domain/media/service';
import { ChatwootClient } from '../../adapters/chatwoot/client';
import { db } from '../../infra/db/client';
import { getCheckinQueue } from '../../infra/queue/client';
import { logExecution } from '../../infra/logging/logger';
import { processCheckinResponse } from './checkin';

/**
 * Detect if the AI asked for the user's name and extract it from the response
 * Also handles proactive name sharing (when user introduces themselves without being asked)
 * Returns the name if found, null otherwise
 */
function extractUserName(userMessage: string, recentMessages: Message[]): string | null {
  // Check if the previous assistant message asked for a name
  const lastAssistantMessage = recentMessages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant');

  // Name request patterns in multiple languages
  const nameRequestPatterns = [
    /cómo te gustaría que te llame/i,
    /cómo te llamas/i,
    /cuál es tu nombre/i,
    /what would you like me to call you/i,
    /what name would you like me to use/i,
    /what name should i use/i,
    /what's your name/i,
    /what is your name/i,
    /como você gostaria que eu te chamasse/i,
    /qual é o seu nome/i,
    /comment aimeriez-vous que je vous appelle/i,
    /quel est votre nom/i,
  ];

  const askedForName = lastAssistantMessage && nameRequestPatterns.some(pattern =>
    pattern.test(lastAssistantMessage.content)
  );

  // Proactive name sharing patterns (user introduces themselves without being asked)
  const proactiveNamePatterns = [
    /\b(mi nombre es|me llamo|soy)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(my name is|i'm|i am)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(meu nome é|me chamo)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
    /\b(je m'appelle|je suis)\s+([A-Za-zÀ-ÿ]+(?:\s+[A-Za-zÀ-ÿ]+)?)/i,
  ];

  // Try proactive extraction first
  for (const pattern of proactiveNamePatterns) {
    const match = userMessage.match(pattern);
    if (match && match[2]) {
      const extractedName = match[2].trim();
      // Validate and capitalize
      const words = extractedName.split(/\s+/);
      if (words.length >= 1 && words.length <= 4) {
        const isValidName = words.every(word => /^[\p{L}]{2,20}$/u.test(word));
        if (isValidName) {
          return words
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        }
      }
    }
  }

  // If AI didn't ask for name and no proactive pattern found, return null
  if (!askedForName) {
    return null;
  }

  // User declined to provide name
  const declinePatterns = [
    /no\s*(,|\.|\s|$)/i,
    /skip/i,
    /omitir/i,
    /prefiero no/i,
    /no (quiero|deseo)/i,
    /pular/i,
    /ignorer/i,
    /prefer not/i,
  ];

  if (declinePatterns.some(pattern => pattern.test(userMessage))) {
    return null;
  }

  // Clean and validate the user's response as a name
  const cleaned = userMessage
    .trim()
    // Remove common prefixes like "me llamo", "my name is", etc.
    .replace(/^(me llamo|soy|mi nombre es|my name is|i'm|i am|je suis|je m'appelle|meu nome é|me chamo)\s+/i, '')
    // Remove punctuation
    .replace(/[.,!?¿¡]+$/g, '')
    .trim();

  // Validate: should be 1-4 words, each 2-20 characters, no numbers or special chars
  const words = cleaned.split(/\s+/);
  if (words.length < 1 || words.length > 4) {
    return null;
  }

  const isValidName = words.every(word => {
    // Each word should be 2-20 chars, only letters (including accented)
    return /^[\p{L}]{2,20}$/u.test(word);
  });

  if (!isValidName) {
    return null;
  }

  // Capitalize each word
  const capitalizedName = words
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  return capitalizedName;
}

/**
 * Detect the language of a message based on common patterns
 * Returns 'es', 'en', 'pt', 'fr' or null if uncertain
 */
function detectLanguage(message: string): 'es' | 'en' | 'pt' | 'fr' | null {
  const lower = message.toLowerCase();

  // Count individual word matches for more accurate detection
  const countMatches = (words: string[]): number => {
    return words.filter(word => new RegExp(`\\b${word}\\b`, 'i').test(lower)).length;
  };

  // Portuguese words
  const ptWords = ['você', 'voce', 'oi', 'olá', 'ola', 'obrigado', 'obrigada', 'tudo', 'bem', 'estou', 'tenho', 'não', 'nao', 'meu', 'minha', 'como', 'está', 'bom', 'dia', 'boa', 'tarde', 'noite', 'por', 'favor', 'dor', 'ontem', 'hoje', 'semana'];
  const ptScore = countMatches(ptWords) + (lower.match(/ção\b|ões\b/g)?.length || 0);

  // Spanish words
  const esWords = ['hola', 'estoy', 'tengo', 'cómo', 'como', 'estás', 'buenos', 'días', 'buenas', 'tardes', 'gracias', 'qué', 'que', 'cuál', 'cual', 'cuándo', 'cuando', 'dónde', 'donde', 'dolor', 'ayer', 'hoy', 'semana'];
  const esScore = countMatches(esWords) + (lower.match(/ción\b/g)?.length || 0);

  // English words (expanded for better detection)
  const enWords = ['hello', 'hi', 'hey', 'i', 'am', 'have', 'has', 'had', 'the', 'a', 'an', 'my', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how', 'please', 'thank', 'thanks', 'yes', 'no', 'not', 'it', 'this', 'that', 'with', 'for', 'on', 'in', 'to', 'and', 'but', 'or', 'eye', 'pain', 'day', 'days', 'week', 'yesterday', 'today', 'started', 'feeling', 'feel'];
  const enScore = countMatches(enWords) + (lower.match(/ing\b/g)?.length || 0);

  // French words
  const frWords = ['bonjour', 'salut', 'je', 'suis', 'ai', 'comment', 'merci', 'oui', 'non', 'le', 'la', 'les', 'mon', 'ma', 'mes', 'que', 'qui', 'où', 'douleur', 'hier', 'aujourd', 'semaine'];
  const frScore = countMatches(frWords);

  // Determine winner
  const scores = [
    { lang: 'pt' as const, score: ptScore },
    { lang: 'es' as const, score: esScore },
    { lang: 'en' as const, score: enScore },
    { lang: 'fr' as const, score: frScore },
  ].sort((a, b) => b.score - a.score);

  const first = scores[0]!;
  const second = scores[1]!;

  // Need at least 2 word matches and clear lead
  if (first.score >= 2 && first.score > second.score) {
    return first.lang;
  }

  // For ties with high scores, prefer English (common second language)
  if (first.score >= 3 && first.score === second.score && (first.lang === 'en' || second.lang === 'en')) {
    return 'en';
  }

  return null;
}

const userService = new UserService(db);
const creditService = new CreditService(db);
const conversationService = new ConversationService(db);
const aiService = new AIService();
const chatwootClient = new ChatwootClient();

// Lazy-loaded check-in service (needs queue which may not be initialized yet)
let checkinService: CheckinService | null = null;
function getCheckinService(): CheckinService {
  if (!checkinService) {
    checkinService = new CheckinService(db, getCheckinQueue());
  }
  return checkinService;
}

export async function handleInboundMessage(
  data: InboundJobData,
  logger: Logger
): Promise<JobResult> {
  const { correlationId, phone, message, conversationId, attachments } = data;

  // Step 1: Load or create user
  const user = await logExecution(
    correlationId,
    'load_user',
    async () => userService.loadOrCreate(phone),
    logger
  );

  logger.info({ userId: user.id, isNew: user.isNew }, 'User loaded');

  // Step 1.5: Update last user message timestamp and check for check-in response
  const checkinSvc = getCheckinService();
  await checkinSvc.updateLastUserMessageAt(user.id);

  // Check if this is a response to a 24h check-in
  const checkinResponse = await processCheckinResponse(user.id, message, conversationId, logger);
  if (checkinResponse.isCheckinResponse && checkinResponse.acknowledgment) {
    // Send the acknowledgment and skip the full AI flow
    await chatwootClient.sendMessage(conversationId, checkinResponse.acknowledgment);
    await checkinSvc.updateLastBotMessageAt(user.id);

    logger.info({ userId: user.id }, 'Processed check-in response');

    return {
      status: 'completed',
      correlationId,
      action: 'checkin_response_processed',
    };
  }

  // Step 2: Check credits (idempotent)
  const creditCheck = await logExecution(
    correlationId,
    'check_credits',
    async () => creditService.checkAndReserve(user.id, 'message', correlationId),
    logger
  );

  if (!creditCheck.hasCredits) {
    // Send no-credits message
    const noCreditsMessage = await conversationService.getTemplate('no_credits', user.language);
    await chatwootClient.sendMessage(conversationId, noCreditsMessage);

    return {
      status: 'completed',
      correlationId,
      action: 'no_credits_response',
    };
  }

  // Step 3: Load conversation context
  const context = await logExecution(
    correlationId,
    'load_context',
    async () => conversationService.loadContext(user.id, conversationId),
    logger
  );

  // Step 4: Process message content (handle media if present)
  // Do this FIRST so we can detect language from transcribed voice messages
  let processedMessage = message;
  const hasVoiceMessage = attachments && attachments.some(a => a.type === 'audio');

  if (attachments && attachments.length > 0) {
    processedMessage = await logExecution(
      correlationId,
      'process_media',
      async () => processAttachments(attachments, message, user.language || 'en', logger),
      logger
    );
  }

  // Step 4.5: Detect and update language
  // Always re-detect for voice messages (user might switch languages)
  // For text, only detect on first few messages
  if (user.isNew || context.messageCount < 5 || hasVoiceMessage) {
    const detectedLang = detectLanguage(processedMessage);
    if (detectedLang && detectedLang !== user.language) {
      await logExecution(
        correlationId,
        'update_language',
        async () => userService.updateLanguage(user.id, detectedLang),
        logger
      );
      user.language = detectedLang;
      logger.info({ userId: user.id, language: detectedLang }, 'User language updated from voice/text');
    }
  }

  // Step 5: Check for safety/urgency
  const safetyCheck = await logExecution(
    correlationId,
    'safety_check',
    async () => conversationService.checkSafety(processedMessage, context),
    logger
  );

  if (safetyCheck.isUrgent) {
    logger.warn({ userId: user.id, type: safetyCheck.type }, 'Urgent message detected');
    // Handle urgent case (crisis protocol)
  }

  // Step 6: Build conversation messages for AI (with history)
  const messages = await logExecution(
    correlationId,
    'build_messages',
    async () => conversationService.buildMessages(context, processedMessage),
    logger
  );

  // Step 7: Call Claude
  const aiResponse = await logExecution(
    correlationId,
    'ai_call',
    async () => aiService.generateResponse(messages, context, user.id, correlationId),
    logger
  );

  // Step 8: Post-process response (includes adding summary link if applicable)
  const cleanedResponse = aiService.postProcess(aiResponse.content, user.id, user.language);

  // Step 9: Extract and save user name if provided (works during onboarding or active phase)
  // IMPORTANT: Must happen BEFORE saving new messages, so getRecentMessages returns
  // the previous assistant message (e.g. "what's your name?") not the new one
  if (!user.name) {
    const recentMessages = await conversationService.getRecentMessages(user.id, 5);
    const extractedName = extractUserName(processedMessage, recentMessages);

    if (extractedName) {
      await logExecution(
        correlationId,
        'save_user_name',
        async () => userService.updateName(user.id, extractedName),
        logger
      );
      user.name = extractedName;
      logger.info({ userId: user.id, name: extractedName }, 'User name extracted and saved');
    }
  }

  // Step 10: Save message to history
  await logExecution(
    correlationId,
    'save_messages',
    async () => conversationService.saveMessages(user.id, conversationId, [
      { role: 'user', content: processedMessage },
      { role: 'assistant', content: cleanedResponse },
    ]),
    logger
  );

  // Step 11: Confirm credit debit
  if (creditCheck.reservationId) {
    await logExecution(
      correlationId,
      'confirm_credit',
      async () => creditService.confirmDebit(creditCheck.reservationId!),
      logger
    );
  }

  // Step 12: Send response via Chatwoot
  await logExecution(
    correlationId,
    'send_response',
    async () => chatwootClient.sendMessage(conversationId, cleanedResponse),
    logger
  );

  // Step 13: Update conversation state
  await logExecution(
    correlationId,
    'update_state',
    async () => conversationService.updateState(user.id, context),
    logger
  );

  // Step 14: Update health summary (async, non-blocking for response)
  // This runs in background to update the live summary for the website
  logExecution(
    correlationId,
    'update_summary',
    async () => conversationService.updateHealthSummary(
      user.id,
      processedMessage,
      cleanedResponse,
      aiService
    ),
    logger
  ).catch((err) => {
    logger.error(
      { err, userId: user.id, correlationId },
      'Failed to update health summary - data may be inconsistent'
    );
  });

  // Step 15: Schedule 24h check-in if this is a summary handoff message
  // Detect summary handoff by looking for the summary link in the response
  if (cleanedResponse.includes('carelog.vivebien.io')) {
    try {
      // Extract case label from the AI response for personalized check-in
      const caseLabel = checkinSvc.extractCaseLabel(cleanedResponse, user.language);

      await checkinSvc.scheduleCheckin(user.id, conversationId, caseLabel || undefined);
      logger.info({ userId: user.id, caseLabel }, '24h check-in scheduled after summary');
    } catch (err) {
      logger.error({ err, userId: user.id }, 'Failed to schedule check-in');
      // Non-blocking - don't fail the message processing
    }
  }

  // Update last bot message timestamp
  await checkinSvc.updateLastBotMessageAt(user.id);

  return {
    status: 'completed',
    correlationId,
    action: 'message_processed',
    tokens: aiResponse.usage,
  };
}

async function processAttachments(
  attachments: Array<{ type: string; url: string }>,
  originalMessage: string,
  language: string,
  logger: Logger
): Promise<string> {
  const processedParts: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'audio') {
      logger.info({ url: attachment.url }, 'Processing audio attachment with Whisper');
      const transcription = await mediaService.transcribeAudio(attachment.url, language);
      if (transcription && !transcription.startsWith('[')) {
        // Successfully transcribed - add as user's spoken words
        processedParts.push(`[Voice message]: ${transcription}`);
      } else {
        processedParts.push(transcription);
      }
    } else if (attachment.type === 'image') {
      logger.info({ url: attachment.url }, 'Processing image with Claude Vision');
      const analysis = await mediaService.analyzeImage(attachment.url, language);
      if (analysis && !analysis.startsWith('[')) {
        // Successfully analyzed - add description
        processedParts.push(`[Image description]: ${analysis}`);
      } else {
        processedParts.push(analysis);
      }
    }
  }

  if (originalMessage) {
    processedParts.unshift(originalMessage);
  }

  return processedParts.join('\n');
}
