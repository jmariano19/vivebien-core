"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInboundMessage = handleInboundMessage;
const service_1 = require("../../domain/user/service");
const service_2 = require("../../domain/health-event/service");
const service_3 = require("../../domain/media/service");
const service_4 = require("../../domain/conversation/service");
const client_1 = require("../../adapters/chatwoot/client");
const client_2 = require("../../infra/db/client");
const logger_1 = require("../../infra/logging/logger");
const language_1 = require("../../shared/language");
const ack_messages_1 = require("../../shared/ack-messages");
const userService = new service_1.UserService(client_2.db);
const healthEventService = new service_2.HealthEventService(client_2.db);
const conversationService = new service_4.ConversationService(client_2.db);
const chatwootClient = new client_1.ChatwootClient();
async function handleInboundMessage(data, logger) {
    const { correlationId, conversationId } = data;
    let responseSent = false;
    try {
        return await _handleInboundMessage(data, logger, () => { responseSent = true; });
    }
    catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({
            correlationId,
            conversationId,
            error: err.message,
            stack: err.stack,
        }, 'Unhandled error in message processing — sending fallback response');
        if (!responseSent) {
            try {
                const detectedLang = (0, language_1.detectLanguage)(data.message) || 'es';
                const fallbackMessages = {
                    es: 'Lo siento, tuve un problema temporal. ¿Podrías intentar enviarlo de nuevo?',
                    en: "Sorry, I had a temporary issue. Could you try sending it again?",
                    pt: 'Desculpe, tive um problema temporário. Poderia tentar novamente?',
                    fr: "Désolé, j'ai eu un problème temporaire. Pourriez-vous réessayer?",
                };
                await chatwootClient.sendMessage(conversationId, fallbackMessages[detectedLang] || fallbackMessages.es);
            }
            catch (sendErr) {
                logger.error({ correlationId, error: sendErr }, 'Failed to send fallback message');
            }
        }
        return {
            status: 'failed',
            correlationId,
            error: err.message,
        };
    }
}
async function _handleInboundMessage(data, logger, markResponseSent) {
    const { correlationId, phone, message, conversationId, attachments } = data;
    // ── Step 1: Load or create user ──────────────────────────────────────────
    const user = await (0, logger_1.logExecution)(correlationId, 'load_user', async () => userService.loadOrCreate(phone), logger);
    logger.info({ userId: user.id, isNew: user.isNew }, 'User loaded');
    // ── Step 2: Transcribe voice messages (Whisper — only AI call during day) ─
    let processedMessage = message;
    let imageUrl = null;
    if (attachments && attachments.length > 0) {
        processedMessage = await (0, logger_1.logExecution)(correlationId, 'process_media', async () => processAttachments(attachments, message, user.language || 'es', logger), logger);
        // Capture image URL for health_events
        const imageAttachment = attachments.find(a => a.type === 'image');
        if (imageAttachment) {
            imageUrl = imageAttachment.url;
        }
    }
    // ── Step 3: Detect & update language (always — user may switch languages) ─
    const detectedLang = (0, language_1.detectLanguage)(processedMessage);
    if (detectedLang && detectedLang !== user.language) {
        await (0, logger_1.logExecution)(correlationId, 'update_language', async () => userService.updateLanguage(user.id, detectedLang), logger);
        user.language = detectedLang;
        logger.info({ userId: user.id, language: detectedLang }, 'Language updated');
    }
    // ── Step 4: Safety check (crisis keywords — no AI) ───────────────────────
    const safetyCheck = await (0, logger_1.logExecution)(correlationId, 'safety_check', async () => conversationService.checkSafety(processedMessage, {
        userId: user.id,
        conversationId,
        phase: 'active',
        messageCount: 0,
        promptVersion: '',
        experimentVariants: {},
        metadata: {},
    }), logger);
    if (safetyCheck.isUrgent) {
        logger.warn({ userId: user.id, type: safetyCheck.type }, 'Crisis message detected');
        // For crisis messages, still save the event, but also send crisis resources
        const crisisMessages = {
            es: 'Tu mensaje es importante para nosotros. Si estás en crisis, por favor llama a la Línea Nacional 800-290-0024 o Línea de la Vida 800-911-2000. Estamos aquí contigo.',
            en: 'Your message matters to us. If you\'re in crisis, please call 988 (Suicide & Crisis Lifeline). We\'re here with you.',
            pt: 'Sua mensagem é importante para nós. Se estiver em crise, ligue para o CVV 188. Estamos aqui com você.',
            fr: 'Votre message est important pour nous. Si vous êtes en crise, appelez le 3114. Nous sommes avec vous.',
        };
        await chatwootClient.sendMessage(conversationId, crisisMessages[user.language] || crisisMessages.es);
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
    const questionDetected = (0, ack_messages_1.isQuestion)(processedMessage);
    // ── Step 6: Save to health_events (raw, unprocessed) ─────────────────────
    const event = await (0, logger_1.logExecution)(correlationId, 'save_health_event', async () => healthEventService.saveEvent({
        userId: user.id,
        rawInput: processedMessage,
        imageUrl,
        language: user.language,
        isQuestion: questionDetected,
        source: 'whatsapp',
    }), logger);
    logger.info({ eventId: event.id, userId: user.id, isQuestion: questionDetected }, 'Health event saved');
    // ── Step 7: Send smart ack (Haiku — mirrors the user's message) ─────────
    const hasImage = !!imageUrl;
    const ackMessage = await (0, ack_messages_1.getSmartAck)(processedMessage, user.language, questionDetected, hasImage);
    await (0, logger_1.logExecution)(correlationId, 'send_ack', async () => chatwootClient.sendMessage(conversationId, ackMessage), logger);
    markResponseSent();
    logger.info({ userId: user.id, ack: ackMessage, isQuestion: questionDetected }, 'Ack sent');
    return {
        status: 'completed',
        correlationId,
        action: questionDetected ? 'question_acked' : 'input_acked',
    };
}
// ============================================================================
// Media Processing (voice → Whisper transcription, images → save URL only)
// ============================================================================
async function processAttachments(attachments, originalMessage, language, logger) {
    const parts = [];
    for (const attachment of attachments) {
        if (attachment.type === 'audio') {
            // Voice messages: transcribe with Whisper (only external call during the day)
            logger.info({ url: attachment.url }, 'Transcribing voice message');
            const transcription = await service_3.mediaService.transcribeAudio(attachment.url, language);
            if (transcription && !transcription.startsWith('[')) {
                parts.push(`[Voice message]: ${transcription}`);
            }
            else {
                parts.push(transcription);
            }
        }
        else if (attachment.type === 'image') {
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
//# sourceMappingURL=inbound.js.map