import { Logger } from 'pino';
import { InboundJobData, JobResult, ConversationContext, Message } from '../../shared/types';
import { UserService } from '../../domain/user/service';
import { CreditService } from '../../domain/credits/service';
import { ConversationService } from '../../domain/conversation/service';
import { AIService } from '../../domain/ai/service';
import { ChatwootClient } from '../../adapters/chatwoot/client';
import { db } from '../../infra/db/client';
import { logExecution } from '../../infra/logging/logger';

/**
 * Detect if the AI asked for the user's name and extract it from the response
 * Returns the name if found, null otherwise
 */
function extractUserName(userMessage: string, recentMessages: Message[]): string | null {
  // Check if the previous assistant message asked for a name
  const lastAssistantMessage = recentMessages
    .slice()
    .reverse()
    .find(m => m.role === 'assistant');

  if (!lastAssistantMessage) {
    return null;
  }

  // Name request patterns in multiple languages
  const nameRequestPatterns = [
    /cómo te gustaría que te llame/i,
    /cómo te llamas/i,
    /cuál es tu nombre/i,
    /what would you like me to call you/i,
    /what's your name/i,
    /what is your name/i,
    /como você gostaria que eu te chamasse/i,
    /qual é o seu nome/i,
    /comment aimeriez-vous que je vous appelle/i,
    /quel est votre nom/i,
  ];

  const askedForName = nameRequestPatterns.some(pattern =>
    pattern.test(lastAssistantMessage.content)
  );

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

const userService = new UserService(db);
const creditService = new CreditService(db);
const conversationService = new ConversationService(db);
const aiService = new AIService();
const chatwootClient = new ChatwootClient();

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
  let processedMessage = message;
  if (attachments && attachments.length > 0) {
    processedMessage = await logExecution(
      correlationId,
      'process_media',
      async () => processAttachments(attachments, message, logger),
      logger
    );
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

  // Step 9: Save message to history
  await logExecution(
    correlationId,
    'save_messages',
    async () => conversationService.saveMessages(user.id, conversationId, [
      { role: 'user', content: processedMessage },
      { role: 'assistant', content: cleanedResponse },
    ]),
    logger
  );

  // Step 10: Extract and save user name if provided during onboarding
  if (context.phase === 'onboarding' && !user.name) {
    const recentMessages = await conversationService.getRecentMessages(user.id, 5);
    const extractedName = extractUserName(processedMessage, recentMessages);

    if (extractedName) {
      await logExecution(
        correlationId,
        'save_user_name',
        async () => userService.updateName(user.id, extractedName),
        logger
      );
      logger.info({ userId: user.id, name: extractedName }, 'User name extracted and saved');
    }
  }

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
  logger: Logger
): Promise<string> {
  const processedParts: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'audio') {
      // TODO: Implement Whisper transcription
      logger.info({ url: attachment.url }, 'Processing audio attachment');
      // const transcription = await whisperService.transcribe(attachment.url);
      // processedParts.push(`[Audio transcription]: ${transcription}`);
      processedParts.push('[Audio message received - transcription pending]');
    } else if (attachment.type === 'image') {
      logger.info({ url: attachment.url }, 'Processing image attachment');
      processedParts.push('[Image received]');
    }
  }

  if (originalMessage) {
    processedParts.unshift(originalMessage);
  }

  return processedParts.join('\n');
}
