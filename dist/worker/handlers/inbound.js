"use strict";
/**
 * Plato Inteligente — Inbound Message Handler
 *
 * Flow: NO AI calls during the day (except Whisper for voice).
 *
 * NEW USER:
 *   1. Create client profile
 *   2. Send intro + Q1
 *   3. Set conversation phase = 'onboarding', onboarding_step = 1
 *
 * ONBOARDING (steps 1-5):
 *   1. Save answer to client profile
 *   2. If step < 5: send next question
 *   3. If step == 5: score archetype → save → send completion + archetype message
 *                    set phase = 'active'
 *
 * ACTIVE:
 *   1. Transcribe voice (Whisper) if needed
 *   2. Detect language
 *   3. Safety check (rule-based, no AI)
 *   4. Save raw input to health_events (processed=FALSE)
 *   5. Send smart ack (Haiku mirrors the user's words)
 *
 * All pattern detection and PDF generation happen in the nightly pipeline.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInboundMessage = handleInboundMessage;
const service_1 = require("../../domain/user/service");
const service_2 = require("../../domain/health-event/service");
const service_3 = require("../../domain/client-profile/service");
const service_4 = require("../../domain/media/service");
const service_5 = require("../../domain/conversation/service");
const client_1 = require("../../adapters/chatwoot/client");
const client_2 = require("../../infra/db/client");
const logger_1 = require("../../infra/logging/logger");
const language_1 = require("../../shared/language");
const ack_messages_1 = require("../../shared/ack-messages");
const onboarding_1 = require("../../shared/onboarding");
const userService = new service_1.UserService(client_2.db);
const healthEventService = new service_2.HealthEventService(client_2.db);
const clientProfileService = new service_3.ClientProfileService(client_2.db);
const conversationService = new service_5.ConversationService(client_2.db);
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
    // ── Step 2: Detect language early (before onboarding check) ─────────────
    const detectedLang = (0, language_1.detectLanguage)(message) || user.language || 'es';
    if (detectedLang !== user.language) {
        await userService.updateLanguage(user.id, detectedLang);
        user.language = detectedLang;
    }
    const lang = user.language || 'es';
    // ── Step 3: Load conversation state ─────────────────────────────────────
    const stateResult = await client_2.db.query('SELECT phase, onboarding_step FROM conversation_state WHERE user_id = $1', [user.id]);
    const currentPhase = stateResult.rows[0]?.phase || 'onboarding';
    const onboardingStep = stateResult.rows[0]?.onboarding_step || 0;
    // ── NEW USER: Start onboarding ───────────────────────────────────────────
    if (user.isNew) {
        logger.info({ userId: user.id }, 'New user — starting onboarding');
        // Create client profile
        await clientProfileService.create(user.id);
        // Send intro + Q1 as a single message
        const intro = (0, onboarding_1.getOnboardingIntro)(lang);
        const q1 = (0, onboarding_1.getQuestion)(1, lang);
        await chatwootClient.sendMessage(conversationId, `${intro}\n\n${q1}`);
        markResponseSent();
        // Set onboarding_step = 1 (waiting for answer to Q1)
        await client_2.db.query(`UPDATE conversation_state
       SET phase = 'onboarding', onboarding_step = 1
       WHERE user_id = $1`, [user.id]);
        return { status: 'completed', correlationId, action: 'onboarding_started' };
    }
    // ── ONBOARDING: Process answer, send next question ───────────────────────
    if (currentPhase === 'onboarding' && onboardingStep >= 1 && onboardingStep <= 5) {
        logger.info({ userId: user.id, step: onboardingStep }, 'Processing onboarding answer');
        // Save this answer
        await clientProfileService.saveOnboardingAnswer(user.id, onboardingStep, message);
        if (onboardingStep < 5) {
            // Send the next question
            const nextStep = onboardingStep + 1;
            const nextQuestion = (0, onboarding_1.getQuestion)(nextStep, lang);
            await chatwootClient.sendMessage(conversationId, nextQuestion);
            markResponseSent();
            // Advance the step
            await client_2.db.query(`UPDATE conversation_state SET onboarding_step = $2 WHERE user_id = $1`, [user.id, nextStep]);
            return { status: 'completed', correlationId, action: `onboarding_q${onboardingStep}_answered` };
        }
        else {
            // Q5 answered — score archetype, send completion messages, move to active
            const profile = await clientProfileService.findByUserId(user.id);
            const answers = profile?.onboardingAnswers ?? [];
            const { archetype, scores } = (0, onboarding_1.detectArchetype)(answers);
            await clientProfileService.setArchetype(user.id, archetype, scores);
            logger.info({ userId: user.id, archetype, scores }, 'Archetype detected');
            // Send completion message + archetype-specific first impression
            const completionMsg = (0, onboarding_1.getOnboardingComplete)(lang);
            const archetypeMsg = (0, onboarding_1.getArchetypeMessage)(archetype, lang);
            await chatwootClient.sendMessage(conversationId, `${completionMsg}\n\n${archetypeMsg}`);
            markResponseSent();
            // Move to active phase
            await client_2.db.query(`UPDATE conversation_state
         SET phase = 'active', onboarding_step = NULL
         WHERE user_id = $1`, [user.id]);
            return { status: 'completed', correlationId, action: 'onboarding_complete' };
        }
    }
    // ── ACTIVE: Normal message flow (save + ack) ─────────────────────────────
    // Step A: Transcribe voice messages (only AI cost during the day)
    let processedMessage = message;
    let imageUrl = null;
    if (attachments && attachments.length > 0) {
        processedMessage = await (0, logger_1.logExecution)(correlationId, 'process_media', async () => processAttachments(attachments, message, lang, logger), logger);
        const imageAttachment = attachments.find(a => a.type === 'image');
        if (imageAttachment) {
            imageUrl = imageAttachment.url;
        }
    }
    // Step B: Re-detect language from processed message (voice may differ)
    const finalLang = (0, language_1.detectLanguage)(processedMessage) || lang;
    if (finalLang !== user.language) {
        await userService.updateLanguage(user.id, finalLang);
        user.language = finalLang;
    }
    // Step C: Safety check (rule-based crisis keywords — no AI)
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
        const crisisMessages = {
            es: 'Tu mensaje es importante para nosotros. Si estás en crisis, por favor llama a la Línea Nacional 800-290-0024 o Línea de la Vida 800-911-2000. Estamos aquí contigo.',
            en: 'Your message matters to us. If you\'re in crisis, please call 988 (Suicide & Crisis Lifeline). We\'re here with you.',
            pt: 'Sua mensagem é importante para nós. Se estiver em crise, ligue para o CVV 188. Estamos aqui com você.',
            fr: 'Votre message est important pour nous. Si vous êtes en crise, appelez le 3114. Nous sommes avec vous.',
        };
        await chatwootClient.sendMessage(conversationId, crisisMessages[user.language] || crisisMessages.es);
        markResponseSent();
        await healthEventService.saveEvent({
            userId: user.id,
            rawInput: processedMessage,
            imageUrl,
            language: user.language,
            isQuestion: false,
            source: 'whatsapp',
        });
        return { status: 'completed', correlationId, action: 'crisis_response_sent' };
    }
    // Step D: Detect if it's a question
    const questionDetected = (0, ack_messages_1.isQuestion)(processedMessage);
    // Step E: Save to health_events (raw, unprocessed — nightly pipeline handles the rest)
    const event = await (0, logger_1.logExecution)(correlationId, 'save_health_event', async () => healthEventService.saveEvent({
        userId: user.id,
        rawInput: processedMessage,
        imageUrl,
        language: user.language,
        isQuestion: questionDetected,
        source: 'whatsapp',
    }), logger);
    logger.info({ eventId: event.id, userId: user.id, isQuestion: questionDetected }, 'Health event saved');
    // Step F: Send smart ack (Haiku mirrors the user's message, ~$0.001)
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
            logger.info({ url: attachment.url }, 'Transcribing voice message');
            const transcription = await service_4.mediaService.transcribeAudio(attachment.url, language);
            if (transcription && !transcription.startsWith('[')) {
                parts.push(`[Voice message]: ${transcription}`);
            }
            else {
                parts.push(transcription);
            }
        }
        else if (attachment.type === 'image') {
            // Images noted only — Vision analysis deferred to nightly pipeline
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