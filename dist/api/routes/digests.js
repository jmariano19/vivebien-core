"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.digestRoutes = digestRoutes;
const service_1 = require("../../domain/digest/service");
const service_2 = require("../../domain/health-event/service");
const client_1 = require("../../adapters/chatwoot/client");
const generator_1 = require("../../domain/pdf/generator");
const client_2 = require("../../infra/db/client");
const logger_1 = require("../../infra/logging/logger");
const digestService = new service_1.DigestService(client_2.db);
const healthEventService = new service_2.HealthEventService(client_2.db);
const chatwootClient = new client_1.ChatwootClient();
// Heads-up messages
const HEADS_UP_MESSAGES = {
    es: 'Estamos terminando tu resumen nocturno. En unos 15 minutos lo tendrás listo.\nSi algo no refleja exactamente tu día o cómo te sentiste, escríbenos aquí mismo. Lo afinamos para que cada noche sea más clara que la anterior.',
    en: "Your nightly summary is almost ready. You'll have it in about 15 minutes.\nIf anything doesn't quite match your day, just write us here. We'll fine-tune it so each night gets clearer.",
    pt: 'Seu resumo noturno está quase pronto. Em uns 15 minutos estará listo.\nSe algo não refletir exatamente seu dia, escreva aqui. Ajustamos para que cada noite seja mais clara.',
    fr: "Votre résumé nocturne est presque prêt. Dans environ 15 minutes il sera là.\nSi quelque chose ne reflète pas votre journée, écrivez-nous ici. On ajuste pour que chaque soir soit plus clair.",
};
async function digestRoutes(app) {
    // GET /api/digests/:userId/latest
    app.get('/:userId/latest', async (request, reply) => {
        const { userId } = request.params;
        try {
            const digest = await digestService.getDigest(userId, new Date().toISOString().split('T')[0]);
            if (!digest) {
                return reply.status(404).send({ success: false, error: 'No digests found' });
            }
            return reply.send({ success: true, digest });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
    // GET /api/digests/:userId?date=YYYY-MM-DD
    app.get('/:userId', async (request, reply) => {
        const { userId } = request.params;
        const { date } = request.query;
        try {
            if (date) {
                const digest = await digestService.getDigest(userId, date);
                if (!digest) {
                    return reply.status(404).send({ success: false, error: `No digest found for ${date}` });
                }
                return reply.send({ success: true, digest });
            }
            return reply.send({ success: true, message: 'Provide ?date=YYYY-MM-DD' });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
    // POST /api/digests/:userId/generate — Generate digest only (no WhatsApp delivery)
    app.post('/:userId/generate', async (request, reply) => {
        const { userId } = request.params;
        try {
            const userResult = await client_2.db.query('SELECT language, name FROM users WHERE id = $1', [userId]);
            if (userResult.rows.length === 0) {
                return reply.status(404).send({ success: false, error: 'User not found' });
            }
            const user = userResult.rows[0];
            const result = await digestService.generateDigest(userId, new Date(), user.language, user.name || undefined);
            return reply.send({
                success: true,
                digest: result.digest,
                eventsProcessed: result.eventsProcessed,
                summaryData: result.summaryData,
            });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
    /**
     * POST /api/digests/:userId/trigger-nightly
     *
     * Manually trigger the FULL nightly sequence:
     * 1. Send heads-up message
     * 2. Generate digest (Haiku)
     * 3. Send summary via WhatsApp
     *
     * Use for testing — skips the 15 min delay.
     */
    app.post('/:userId/trigger-nightly', async (request, reply) => {
        const { userId } = request.params;
        const { skipHeadsUp } = request.body || {};
        try {
            // 1. Load user
            const userResult = await client_2.db.query('SELECT language, name FROM users WHERE id = $1', [userId]);
            if (userResult.rows.length === 0) {
                return reply.status(404).send({ success: false, error: 'User not found' });
            }
            const user = userResult.rows[0];
            // 2. Find their conversation via Chatwoot API (look up by phone)
            const phoneResult = await client_2.db.query('SELECT phone FROM users WHERE id = $1', [userId]);
            const phone = phoneResult.rows[0]?.phone;
            if (!phone) {
                return reply.status(404).send({ success: false, error: 'No phone number found for user' });
            }
            const conversationId = await chatwootClient.findConversationByPhone(phone);
            if (!conversationId) {
                return reply.status(404).send({ success: false, error: 'No conversation found in Chatwoot for this user' });
            }
            // 3. Check for events
            const today = new Date().toISOString().split('T')[0];
            const events = await healthEventService.getUnprocessedEvents(userId, today);
            if (events.length === 0) {
                return reply.send({ success: false, error: 'No unprocessed events today', eventsCount: 0 });
            }
            // 4. Send heads-up (optional)
            if (!skipHeadsUp) {
                const headsUpMsg = HEADS_UP_MESSAGES[user.language] || HEADS_UP_MESSAGES.es;
                await chatwootClient.sendMessage(conversationId, headsUpMsg);
            }
            // 5. Generate digest
            const result = await digestService.generateDigest(userId, new Date(), user.language, user.name || undefined);
            // 6. Generate PDF and send via WhatsApp
            let pdfSent = false;
            if (result.summaryData && Object.keys(result.summaryData).length > 0) {
                // Try to generate branded PDF
                try {
                    const pdfBuffer = await (0, generator_1.generateSummaryPdf)(result.summaryData);
                    if (pdfBuffer) {
                        const userName = (result.summaryData.greeting_name || user.name || 'User').replace(/\s+/g, '_');
                        const dateStr = new Date().toISOString().split('T')[0];
                        const fileName = `Plato_Inteligente_${userName}_${dateStr}.pdf`;
                        await chatwootClient.sendAttachment(conversationId, pdfBuffer, fileName, '📋 Tu resumen nocturno está listo. Ábrelo para ver tu análisis completo de hoy.');
                        pdfSent = true;
                        logger_1.logger.info({ userId, fileName }, 'PDF summary sent via WhatsApp');
                    }
                }
                catch (pdfError) {
                    const pdfErr = pdfError instanceof Error ? pdfError : new Error(String(pdfError));
                    logger_1.logger.warn({ error: pdfErr.message, userId }, 'PDF generation failed, falling back to text');
                }
                // Fallback: send text summary if PDF failed
                if (!pdfSent) {
                    const summaryText = formatSummaryForWhatsApp(result.summaryData, user.language);
                    await chatwootClient.sendMessage(conversationId, summaryText);
                }
            }
            return reply.send({
                success: true,
                eventsProcessed: result.eventsProcessed,
                digest: result.digest,
                summaryData: result.summaryData,
                deliveredTo: conversationId,
                pdfSent,
            });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            request.log.error({ error: err.message, userId }, 'Manual nightly trigger failed');
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
    /**
     * GET /api/digests/events/:userId — View today's health events for a user
     */
    app.get('/events/:userId', async (request, reply) => {
        const { userId } = request.params;
        const { date } = request.query;
        try {
            const targetDate = date || new Date().toISOString().split('T')[0];
            const events = await healthEventService.getUnprocessedEvents(userId, targetDate);
            return reply.send({
                success: true,
                date: targetDate,
                count: events.length,
                events,
            });
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            return reply.status(500).send({ success: false, error: err.message });
        }
    });
}
// ============================================================================
// WhatsApp formatter (same as in worker/index.ts)
// ============================================================================
function formatSummaryForWhatsApp(data, language) {
    const lines = [];
    lines.push('_La comida y tu estilo de vida son medicina — con verdad y entendimiento._');
    lines.push('');
    const name = data.greeting_name || '';
    lines.push(`*${name}, tu día tiene un patrón. Hoy lo hicimos visible.*`);
    lines.push(`Día ${data.day_number || 1} — ${data.date || ''}`);
    lines.push('');
    const meals = data.meals || [];
    if (meals.length > 0) {
        lines.push('*🍽 TU PLATO HOY*');
        for (const meal of meals) {
            lines.push(`*${meal.time}* — ${meal.title}`);
            for (const bullet of (meal.bullets || [])) {
                lines.push(`  • ${bullet}`);
            }
        }
        lines.push('');
    }
    if (data.signal_intro) {
        lines.push('*📊 SEÑAL PRINCIPAL DE HOY*');
        lines.push(data.signal_intro);
        const items = data.signal_items || [];
        for (const item of items) {
            const arrow = item.direction === 'up' ? '↑' : '↓';
            lines.push(`  ${arrow} ${item.text}`);
        }
        if (data.signal_explanation) {
            lines.push(`\n_${data.signal_explanation}_`);
        }
        lines.push('');
    }
    if (data.willpower_text) {
        lines.push('*💪 ESTO NO ES FUERZA DE VOLUNTAD*');
        lines.push(data.willpower_text);
        lines.push('');
    }
    if (data.advantage_text) {
        lines.push('*⚡ TU VENTAJA METABÓLICA*');
        lines.push(data.advantage_text);
        lines.push('');
    }
    if (data.pattern_text) {
        lines.push('*🔍 PATRÓN EMERGENTE*');
        lines.push(data.pattern_text);
        lines.push('');
    }
    const questions = data.questions || [];
    if (questions.length > 0) {
        lines.push('*❓ TUS PREGUNTAS*');
        for (const q of questions) {
            lines.push(`_Tu preguntaste: "${q.question}"_`);
            lines.push(q.answer);
            lines.push('');
        }
    }
    if (data.experiment_heading) {
        lines.push('*🧪 EXPERIMENTO PARA MAÑANA*');
        lines.push(data.experiment_heading);
        const steps = data.experiment_steps || [];
        steps.forEach((step, i) => {
            lines.push(`${i + 1}. ${step}`);
        });
        if (data.observe_text) {
            lines.push(`\n🔎 Observa: ${data.observe_text}`);
        }
        lines.push('');
    }
    lines.push('_No estás haciendo dieta. Estás aprendiendo a leer tu biología._');
    lines.push('');
    lines.push('Revisión: Dra. Hernández | Tu Plato Inteligente');
    return lines.join('\n');
}
//# sourceMappingURL=digests.js.map