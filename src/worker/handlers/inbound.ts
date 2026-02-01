import { Logger } from 'pino';
import { InboundJobData, JobResult, ConversationContext } from '../../shared/types';
import { UserService } from '../../domain/user/service';
import { CreditService } from '../../domain/credits/service';
import { ConversationService } from '../../domain/conversation/service';
import { AIService } from '../../domain/ai/service';
import { ChatwootClient } from '../../adapters/chatwoot/client';
import { db } from '../../infra/db/client';
import { logExecution } from '../../infra/logging/logger';

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

  // Step 10: Confirm credit debit
  if (creditCheck.reservationId) {
    await logExecution(
      correlationId,
      'confirm_credit',
      async () => creditService.confirmDebit(creditCheck.reservationId!),
      logger
    );
  }

  // Step 11: Send response via Chatwoot
  await logExecution(
    correlationId,
    'send_response',
    async () => chatwootClient.sendMessage(conversationId, cleanedResponse),
    logger
  );

  // Step 12: Update conversation state
  await logExecution(
    correlationId,
    'update_state',
    async () => conversationService.updateState(user.id, context),
    logger
  );

  // Step 13: Update health summary (async, non-blocking for response)
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
