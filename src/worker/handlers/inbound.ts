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
import { detectLanguage, extractUserName, extractNameFromAIResponse } from '../../shared/language';
import { detectConcernCommand, getCommandConfirmationMessage, getCommandErrorMessage } from '../../shared/concern-commands';
import { ConcernCommandExecutor } from '../../domain/concern/command-executor';

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
  let responseSent = false;

  try {
    return await _handleInboundMessage(data, logger, () => { responseSent = true; });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({
      correlationId,
      conversationId,
      phone,
      error: err.message,
      stack: err.stack,
    }, 'Unhandled error in message processing — sending fallback response');

    // Best-effort fallback: send a user-friendly error message so bot never goes silent
    if (!responseSent) {
      try {
        const detectedLang = detectLanguage(message) || 'es';
        const fallbackMessages: Record<string, string> = {
          es: 'Lo siento, tuve un problema temporal procesando tu mensaje. ¿Podrías intentar enviarlo de nuevo?',
          en: "I'm sorry, I had a temporary issue processing your message. Could you try sending it again?",
          pt: 'Desculpe, tive um problema temporário ao processar sua mensagem. Poderia tentar enviar novamente?',
          fr: "Je suis désolé, j'ai eu un problème temporaire. Pourriez-vous réessayer?",
        };
        const fallbackMsg = fallbackMessages[detectedLang] || fallbackMessages.es!;
        // Include debug info temporarily to diagnose the crash
        const debugMsg = `${fallbackMsg}\n\n_[debug: ${err.message?.substring(0, 200)}]_`;
        await chatwootClient.sendMessage(conversationId, debugMsg);
        logger.info({ correlationId, conversationId }, 'Fallback error message sent to user');
      } catch (sendErr) {
        logger.error({ correlationId, conversationId, error: sendErr }, 'Failed to send fallback message — user received no response');
      }
    }

    // Return failed instead of re-throwing to prevent retries that send duplicate fallbacks
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
    markResponseSent();
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
    markResponseSent();

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
      context.language = detectedLang; // Keep context in sync for system prompt
      logger.info({ userId: user.id, language: detectedLang }, 'User language updated from voice/text');
    }
  }

  // Step 4.7: Check for concern management commands (merge, delete, rename)
  const concernCommand = detectConcernCommand(processedMessage, user.language || 'en');
  if (concernCommand) {
    try {
      const executor = new ConcernCommandExecutor(db, logger);
      let affectedConcerns: string[] = [];

      if (concernCommand.type === 'merge') {
        affectedConcerns = await executor.executeMerge(user.id, concernCommand.targets);
      } else if (concernCommand.type === 'delete') {
        affectedConcerns = await executor.executeDelete(user.id, concernCommand.targets[0]!);
      } else if (concernCommand.type === 'rename') {
        affectedConcerns = await executor.executeRename(user.id, concernCommand.targets[0]!, concernCommand.newName!);
      }

      const confirmationMsg = getCommandConfirmationMessage(concernCommand, affectedConcerns);
      await chatwootClient.sendMessage(conversationId, confirmationMsg);
      markResponseSent();

      // Save the command and confirmation to message history
      await conversationService.saveMessages(user.id, conversationId, [
        { role: 'user', content: processedMessage },
        { role: 'assistant', content: confirmationMsg },
      ]);

      await checkinSvc.updateLastBotMessageAt(user.id);

      logger.info(
        { userId: user.id, commandType: concernCommand.type, targets: concernCommand.targets },
        'Concern command executed successfully'
      );

      return {
        status: 'completed',
        correlationId,
        action: 'concern_command_executed',
      };
    } catch (err) {
      logger.error(
        { err, userId: user.id, commandType: concernCommand.type },
        'Failed to execute concern command'
      );

      const errorMsg = getCommandErrorMessage(user.language || 'en');
      await chatwootClient.sendMessage(conversationId, errorMsg);
      markResponseSent();
      await checkinSvc.updateLastBotMessageAt(user.id);

      return {
        status: 'completed',
        correlationId,
        action: 'concern_command_failed',
      };
    }
  }

  // Step 5: Check for safety/urgency
  const safetyCheck = await logExecution(
    correlationId,
    'safety_check',
    async () => conversationService.checkSafety(processedMessage, context),
    logger
  );

  let isCrisisMessage = false;
  if (safetyCheck.isUrgent) {
    logger.warn({ userId: user.id, type: safetyCheck.type }, 'Urgent message detected');
    isCrisisMessage = true;
  }

  // Step 6: Build conversation messages for AI (with history)
  let messages = await logExecution(
    correlationId,
    'build_messages',
    async () => conversationService.buildMessages(context, processedMessage),
    logger
  );

  // Step 6.5: Inject crisis guidance if needed
  if (isCrisisMessage) {
    messages.push({
      role: 'user' as const,
      content: '[SYSTEM NOTE: This person may be in crisis or distress. Respond with empathy, validate their feelings, and include relevant crisis resources. In Spanish: Línea Nacional 800-290-0024, Línea de la Vida 800-911-2000. In English: 988 Suicide & Crisis Lifeline (call/text 988). In Portuguese: CVV 188. In French: 3114.]'
    });
  }

  // Step 7: Call Claude
  const aiResponse = await logExecution(
    correlationId,
    'ai_call',
    async () => aiService.generateResponse(messages, context, user.id, correlationId),
    logger
  );

  // Step 8: Post-process response (basic cleaning)
  const cleanedResponse = aiService.postProcess(aiResponse.content);

  // Step 9: Extract and save user name if provided naturally in conversation
  if (!user.name) {
    const recentMessages = await conversationService.getRecentMessages(user.id, 5);
    const extractedName = extractUserName(processedMessage, recentMessages);
    const finalName = extractedName || extractNameFromAIResponse(cleanedResponse);

    if (finalName) {
      await logExecution(
        correlationId,
        'save_user_name',
        async () => userService.updateName(user.id, finalName),
        logger
      );
      user.name = finalName;
      logger.info({ userId: user.id, name: finalName }, 'User name extracted and saved');
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

  // Step 12: Send response via Chatwoot — single natural message, no splits
  await logExecution(
    correlationId,
    'send_response',
    async () => chatwootClient.sendMessage(conversationId, cleanedResponse),
    logger
  );
  markResponseSent();

  // Step 13: Update conversation state
  await logExecution(
    correlationId,
    'update_state',
    async () => conversationService.updateState(user.id, context),
    logger
  );

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
