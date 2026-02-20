"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckinService = void 0;
const logger_1 = require("../../infra/logging/logger");
const client_1 = require("../../adapters/chatwoot/client");
// 24 hours in milliseconds
const CHECKIN_DELAY_MS = 24 * 60 * 60 * 1000;
// 6 hours - if conversation active within this window, skip check-in
const ACTIVE_CONVERSATION_WINDOW_MS = 6 * 60 * 60 * 1000;
class CheckinService {
    db;
    checkinQueue;
    chatwootClient;
    constructor(db, checkinQueue) {
        this.db = db;
        this.checkinQueue = checkinQueue;
        this.chatwootClient = new client_1.ChatwootClient();
    }
    // ============================================================================
    // Message Templates
    // ============================================================================
    getCheckinMessage(name, caseLabel, language) {
        // Permission-based continuity: gentle reminder that their note exists,
        // not a push to report back. The user should feel they have a calm place
        // to return to, not that they're being monitored.
        const templates = {
            es: {
                withName: `Hola {name} 👋

Tu nota sobre ${caseLabel || 'tu salud'} sigue aquí, organizada y lista.

Si algo ha cambiado — aunque sea algo pequeño — puedes contarme y lo agrego.`,
                withoutName: `Hola 👋

Tu nota sobre ${caseLabel || 'tu salud'} sigue aquí, organizada y lista.

Si algo ha cambiado — aunque sea algo pequeño — puedes contarme y lo agrego.`,
            },
            en: {
                withName: `Hi {name} 👋

Your note about ${caseLabel || 'your health'} is still here, organized and ready.

If anything has changed — even something small — you can tell me and I'll add it.`,
                withoutName: `Hi 👋

Your note about ${caseLabel || 'your health'} is still here, organized and ready.

If anything has changed — even something small — you can tell me and I'll add it.`,
            },
            pt: {
                withName: `Oi {name} 👋

Sua nota sobre ${caseLabel || 'sua saúde'} continua aqui, organizada e pronta.

Se algo mudou — mesmo algo pequeno — pode me contar que eu adiciono.`,
                withoutName: `Oi 👋

Sua nota sobre ${caseLabel || 'sua saúde'} continua aqui, organizada e pronta.

Se algo mudou — mesmo algo pequeno — pode me contar que eu adiciono.`,
            },
            fr: {
                withName: `Bonjour {name} 👋

Votre note sur ${caseLabel || 'votre santé'} est toujours là, organisée et prête.

Si quelque chose a changé — même quelque chose de petit — vous pouvez me le dire et je l'ajouterai.`,
                withoutName: `Bonjour 👋

Votre note sur ${caseLabel || 'votre santé'} est toujours là, organisée et prête.

Si quelque chose a changé — même quelque chose de petit — vous pouvez me le dire et je l'ajouterai.`,
            },
        };
        const langTemplates = templates[language] || templates.en;
        if (name) {
            return langTemplates.withName.replace('{name}', name);
        }
        return langTemplates.withoutName;
    }
    getCheckinAcknowledgment(userResponse, language) {
        const lowerResponse = userResponse.toLowerCase();
        // Detect response type
        const isSame = /\b(same|igual|mesmo|pareil|sin cambio|no change)\b/i.test(lowerResponse);
        const isBetter = /\b(better|mejor|melhor|mieux|less pain|menos dolor|improvement|mejora)\b/i.test(lowerResponse);
        const isWorse = /\b(worse|peor|pior|pire|more pain|más dolor|swelling|hincha|empeor)\b/i.test(lowerResponse);
        // Containment-first acknowledgments: calm, grounded, reinforce that info is safely captured
        const responses = {
            same: {
                es: {
                    message: 'Anotado — tu nota ahora refleja que sigue igual. No necesitas recordar esto, está guardado.\n\nSi algo cambia después, solo escríbeme.',
                    noteEntry: `Seguimiento: Sin cambios significativos - "${userResponse}"`,
                },
                en: {
                    message: "Noted — your note now reflects that it's about the same. You don't need to remember this, it's saved.\n\nIf anything changes later, just tell me.",
                    noteEntry: `Follow-up: No significant changes - "${userResponse}"`,
                },
                pt: {
                    message: 'Anotado — sua nota agora reflete que continua igual. Você não precisa lembrar disso, está salvo.\n\nSe algo mudar depois, é só me escrever.',
                    noteEntry: `Acompanhamento: Sem mudanças significativas - "${userResponse}"`,
                },
                fr: {
                    message: "Noté — votre note reflète maintenant que c'est à peu près pareil. Vous n'avez pas besoin de retenir cela, c'est sauvegardé.\n\nSi ça change plus tard, dites-le moi.",
                    noteEntry: `Suivi: Pas de changements significatifs - "${userResponse}"`,
                },
            },
            better: {
                es: {
                    message: 'Qué bueno — he actualizado tu nota con la mejoría. Está todo organizado.\n\nSi algo más cambia, aquí estoy.',
                    noteEntry: `Seguimiento: Mejoría reportada - "${userResponse}"`,
                },
                en: {
                    message: "Good to hear — I've updated your note with the improvement. Everything's organized.\n\nIf anything else changes, I'm here.",
                    noteEntry: `Follow-up: Improvement reported - "${userResponse}"`,
                },
                pt: {
                    message: 'Que bom — atualizei sua nota com a melhora. Está tudo organizado.\n\nSe algo mais mudar, estou aqui.',
                    noteEntry: `Acompanhamento: Melhora reportada - "${userResponse}"`,
                },
                fr: {
                    message: "Bonne nouvelle — j'ai mis à jour votre note avec l'amélioration. Tout est organisé.\n\nSi autre chose change, je suis là.",
                    noteEntry: `Suivi: Amélioration signalée - "${userResponse}"`,
                },
            },
            worse: {
                es: {
                    message: 'Gracias por contarme. He añadido esto a tu nota.\n\nSi quieres, cuéntame un poco más sobre qué cambió y lo organizo claramente para tu médico.',
                    noteEntry: `Seguimiento: Empeoramiento reportado - "${userResponse}"`,
                },
                en: {
                    message: "Thank you for sharing that. I've added it to your note.\n\nIf you'd like, tell me a bit more about what changed and I'll organize it clearly for your doctor.",
                    noteEntry: `Follow-up: Worsening reported - "${userResponse}"`,
                },
                pt: {
                    message: 'Obrigado por compartilhar. Adicionei isso à sua nota.\n\nSe quiser, me conte um pouco mais sobre o que mudou e eu organizo claramente para seu médico.',
                    noteEntry: `Acompanhamento: Piora reportada - "${userResponse}"`,
                },
                fr: {
                    message: "Merci de me le dire. J'ai ajouté cela à votre note.\n\nSi vous voulez, dites-moi ce qui a changé et je l'organiserai clairement pour votre médecin.",
                    noteEntry: `Suivi: Aggravation signalée - "${userResponse}"`,
                },
            },
            default: {
                es: {
                    message: 'Anotado — he actualizado tu nota. No necesitas recordar esto, está guardado.\n\nSi algo más cambia, solo escríbeme.',
                    noteEntry: `Seguimiento: "${userResponse}"`,
                },
                en: {
                    message: "Noted — I've updated your note. You don't need to remember this, it's saved.\n\nIf anything else changes, just tell me.",
                    noteEntry: `Follow-up: "${userResponse}"`,
                },
                pt: {
                    message: 'Anotado — atualizei sua nota. Você não precisa lembrar disso, está salvo.\n\nSe algo mais mudar, é só me escrever.',
                    noteEntry: `Acompanhamento: "${userResponse}"`,
                },
                fr: {
                    message: "Noté — j'ai mis à jour votre note. Vous n'avez pas besoin de retenir cela, c'est sauvegardé.\n\nSi autre chose change, dites-le moi.",
                    noteEntry: `Suivi: "${userResponse}"`,
                },
            },
        };
        let responseType = 'default';
        if (isSame)
            responseType = 'same';
        else if (isBetter)
            responseType = 'better';
        else if (isWorse)
            responseType = 'worse';
        const langResponses = responses[responseType][language] || responses[responseType].en;
        return langResponses;
    }
    // ============================================================================
    // State Management
    // ============================================================================
    async getCheckinState(userId) {
        const result = await this.db.query(`SELECT
        COALESCE(checkin_status, 'not_scheduled') as checkin_status,
        checkin_scheduled_for,
        last_summary_created_at,
        last_user_message_at,
        last_bot_message_at,
        case_label
       FROM conversation_state
       WHERE user_id = $1`, [userId]);
        if (result.rows.length === 0) {
            return null;
        }
        const row = result.rows[0];
        return {
            userId,
            status: row.checkin_status,
            scheduledFor: row.checkin_scheduled_for || undefined,
            lastSummaryCreatedAt: row.last_summary_created_at || undefined,
            lastUserMessageAt: row.last_user_message_at || undefined,
            lastBotMessageAt: row.last_bot_message_at || undefined,
            caseLabel: row.case_label || undefined,
        };
    }
    async updateCheckinStatus(userId, status, scheduledFor) {
        await this.db.query(`UPDATE conversation_state
       SET checkin_status = $1,
           checkin_scheduled_for = $2
       WHERE user_id = $3`, [status, scheduledFor || null, userId]);
    }
    async updateLastSummaryCreatedAt(userId, caseLabel) {
        await this.db.query(`UPDATE conversation_state
       SET last_summary_created_at = NOW(),
           case_label = COALESCE($2, case_label)
       WHERE user_id = $1`, [userId, caseLabel || null]);
    }
    async updateLastUserMessageAt(userId) {
        await this.db.query(`UPDATE conversation_state
       SET last_user_message_at = NOW()
       WHERE user_id = $1`, [userId]);
    }
    async updateLastBotMessageAt(userId) {
        await this.db.query(`UPDATE conversation_state
       SET last_bot_message_at = NOW()
       WHERE user_id = $1`, [userId]);
    }
    // ============================================================================
    // Scheduling
    // ============================================================================
    /**
     * Schedule a 24-hour check-in after a summary is created
     * Called immediately after sending the post-summary handoff message
     */
    async scheduleCheckin(userId, conversationId, caseLabel) {
        // Cancel any existing scheduled check-in
        await this.cancelExistingCheckin(userId);
        const scheduledFor = new Date(Date.now() + CHECKIN_DELAY_MS);
        // Update state
        await this.updateLastSummaryCreatedAt(userId, caseLabel);
        await this.updateCheckinStatus(userId, 'scheduled', scheduledFor);
        // Add job to queue with 24h delay
        await this.checkinQueue.add('checkin', {
            userId,
            conversationId,
            scheduledAt: new Date().toISOString(),
        }, {
            delay: CHECKIN_DELAY_MS,
            jobId: `checkin-${userId}`, // Use userId as job ID to allow easy cancellation
            removeOnComplete: true,
            removeOnFail: false,
        });
        logger_1.logger.info({ userId, scheduledFor, caseLabel }, '24h check-in scheduled');
    }
    /**
     * Cancel an existing scheduled check-in
     */
    async cancelExistingCheckin(userId) {
        try {
            const job = await this.checkinQueue.getJob(`checkin-${userId}`);
            if (job) {
                await job.remove();
                logger_1.logger.info({ userId }, 'Existing check-in job removed');
            }
        }
        catch (err) {
            // Job may not exist, that's fine
            logger_1.logger.debug({ userId, err }, 'No existing check-in job to remove');
        }
        await this.updateCheckinStatus(userId, 'canceled');
    }
    // ============================================================================
    // Execution
    // ============================================================================
    /**
     * Execute the check-in when the job fires
     * Returns true if message was sent, false if skipped
     */
    async executeCheckin(userId, conversationId) {
        const state = await this.getCheckinState(userId);
        if (!state) {
            logger_1.logger.warn({ userId }, 'No check-in state found, skipping');
            return false;
        }
        // Check if status is still 'scheduled'
        if (state.status !== 'scheduled') {
            logger_1.logger.info({ userId, status: state.status }, 'Check-in not in scheduled state, skipping');
            return false;
        }
        // Check if user sent any message after the summary was created
        if (state.lastUserMessageAt && state.lastSummaryCreatedAt) {
            if (state.lastUserMessageAt > state.lastSummaryCreatedAt) {
                logger_1.logger.info({ userId }, 'User sent message after summary, canceling check-in');
                await this.updateCheckinStatus(userId, 'canceled');
                return false;
            }
        }
        // Check if there's been active conversation in the last 6 hours
        const sixHoursAgo = new Date(Date.now() - ACTIVE_CONVERSATION_WINDOW_MS);
        if (state.lastBotMessageAt && state.lastBotMessageAt > sixHoursAgo) {
            if (state.lastUserMessageAt && state.lastUserMessageAt > sixHoursAgo) {
                logger_1.logger.info({ userId }, 'Active conversation in last 6h, canceling check-in');
                await this.updateCheckinStatus(userId, 'canceled');
                return false;
            }
        }
        // Get user info for personalization
        const userResult = await this.db.query(`SELECT name, COALESCE(language, 'en') as language FROM users WHERE id = $1`, [userId]);
        if (userResult.rows.length === 0) {
            logger_1.logger.warn({ userId }, 'User not found, skipping check-in');
            await this.updateCheckinStatus(userId, 'canceled');
            return false;
        }
        const user = userResult.rows[0];
        const message = this.getCheckinMessage(user.name, state.caseLabel || null, user.language);
        // Send the check-in message
        try {
            await this.chatwootClient.sendMessage(conversationId, message);
            await this.updateCheckinStatus(userId, 'sent');
            await this.updateLastBotMessageAt(userId);
            logger_1.logger.info({ userId, conversationId }, '24h check-in message sent');
            return true;
        }
        catch (err) {
            logger_1.logger.error({ userId, err }, 'Failed to send check-in message');
            throw err;
        }
    }
    /**
     * Handle user's response to a check-in
     * Returns the acknowledgment message to send, or null if not a check-in response
     */
    async handleCheckinResponse(userId, userMessage) {
        const state = await this.getCheckinState(userId);
        if (!state || state.status !== 'sent') {
            return null;
        }
        // Get user language
        const userResult = await this.db.query(`SELECT COALESCE(language, 'en') as language FROM users WHERE id = $1`, [userId]);
        const language = userResult.rows[0]?.language || 'en';
        const response = this.getCheckinAcknowledgment(userMessage, language);
        // Mark check-in as completed
        await this.updateCheckinStatus(userId, 'completed');
        return {
            acknowledgment: response.message,
            noteEntry: response.noteEntry,
        };
    }
    // ============================================================================
    // Case Label Extraction
    // ============================================================================
    /**
     * Extract a simple case label from the summary for use in check-in message
     * e.g., "your eye", "your back", "your headache"
     */
    extractCaseLabel(summary, language) {
        const patterns = {
            en: [
                /\b(eye|eyes)\b/i,
                /\b(back|lower back|upper back)\b/i,
                /\b(head|headache)\b/i,
                /\b(throat)\b/i,
                /\b(stomach|abdomen)\b/i,
                /\b(chest)\b/i,
                /\b(knee|ankle|wrist|shoulder|elbow)\b/i,
                /\b(sty|stye|orzuelo)\b/i,
            ],
            es: [
                /\b(ojo|ojos)\b/i,
                /\b(espalda)\b/i,
                /\b(cabeza|dolor de cabeza)\b/i,
                /\b(garganta)\b/i,
                /\b(estómago|abdomen)\b/i,
                /\b(pecho)\b/i,
                /\b(rodilla|tobillo|muñeca|hombro|codo)\b/i,
                /\b(orzuelo)\b/i,
            ],
        };
        const langPatterns = patterns[language] || patterns.en;
        const prefixes = {
            en: 'your ',
            es: 'tu ',
            pt: 'seu ',
            fr: 'votre ',
        };
        for (const pattern of langPatterns) {
            const match = summary.match(pattern);
            if (match) {
                const prefix = prefixes[language] || prefixes.en;
                return prefix + match[0].toLowerCase();
            }
        }
        return null;
    }
}
exports.CheckinService = CheckinService;
//# sourceMappingURL=service.js.map