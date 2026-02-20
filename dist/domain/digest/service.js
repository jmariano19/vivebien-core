"use strict";
/**
 * Plato Inteligente — Nightly Digest Service
 *
 * Generates the nightly summary using ONE Haiku call:
 * 1. Collect all unprocessed health_events for the day
 * 2. Load user profile + last 7 days of events for patterns
 * 3. Send ONE Haiku call with the Nightly Summary Framework prompt
 * 4. Receive structured JSON matching the PDF data dict
 * 5. Mark events as processed
 * 6. Save digest to daily_digests table
 *
 * Cost: ~$0.005-0.01 per user per night (Haiku 4.5)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DigestService = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../../config");
const logger_1 = require("../../infra/logging/logger");
const service_1 = require("../health-event/service");
const rate_limiter_1 = require("../../shared/rate-limiter");
// ============================================================================
// Service
// ============================================================================
class DigestService {
    db;
    client;
    rateLimiter;
    healthEventService;
    constructor(db) {
        this.db = db;
        this.client = new sdk_1.default({ apiKey: config_1.config.anthropicApiKey });
        this.rateLimiter = new rate_limiter_1.RateLimiter({ maxRequestsPerMinute: config_1.config.claudeRpmLimit });
        this.healthEventService = new service_1.HealthEventService(db);
    }
    /**
     * Generate the full nightly digest for a user.
     * ONE Haiku call processes the entire day.
     */
    async generateDigest(userId, date, language, userName) {
        const dateStr = date.toISOString().split('T')[0];
        logger_1.logger.info({ userId, date: dateStr, language }, 'Starting nightly digest generation');
        // 1. Get today's unprocessed events
        const todayEvents = await this.healthEventService.getUnprocessedEvents(userId, dateStr);
        if (todayEvents.length === 0) {
            logger_1.logger.info({ userId, date: dateStr }, 'No events to digest');
            const digest = await this.saveDigest(userId, dateStr, 0, null, null);
            return { digest, summaryData: {}, eventsProcessed: 0 };
        }
        // 2. Get last 7 days for pattern detection
        const weekAgo = new Date(date);
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekEvents = await this.healthEventService.getEventsByDateRange(userId, weekAgo.toISOString().split('T')[0], dateStr);
        // 3. Load user profile
        const profile = await this.loadUserProfile(userId, userName, language);
        // 4. Get recent summaries for continuity
        const recentSummaries = await this.getRecentSummaries(userId, 3);
        // 5. Generate the summary with ONE Haiku call
        const summaryData = await this.generateSummaryWithHaiku(todayEvents, weekEvents, profile, recentSummaries);
        // 6. Mark today's events as processed
        for (const event of todayEvents) {
            try {
                // Extract event type from the AI's analysis
                const eventType = this.inferEventType(event);
                await this.healthEventService.markProcessed(event.id, eventType, {
                    processedAt: new Date().toISOString(),
                    digestDate: dateStr,
                });
            }
            catch (err) {
                logger_1.logger.warn({ eventId: event.id, error: err }, 'Failed to mark event processed');
            }
        }
        // 7. Save the digest
        const digest = await this.saveDigest(userId, dateStr, todayEvents.length, null, // PDF URL — filled after PDF generation
        summaryData);
        logger_1.logger.info({ userId, date: dateStr, eventCount: todayEvents.length }, 'Nightly digest generated');
        return {
            digest,
            summaryData,
            eventsProcessed: todayEvents.length,
        };
    }
    /**
     * The ONE AI call — Haiku processes the entire day.
     */
    async generateSummaryWithHaiku(todayEvents, weekEvents, profile, recentSummaries) {
        await this.rateLimiter.acquire();
        // Format today's events for the prompt
        const todayFormatted = todayEvents.map(e => ({
            time: new Date(e.eventTime).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }),
            raw_input: e.rawInput,
            has_image: !!e.imageUrl,
            is_question: e.isQuestion,
        }));
        // Format week events summary (just counts + key items)
        const weekSummary = this.summarizeWeekEvents(weekEvents, todayEvents);
        // Format recent summaries for continuity
        const recentContext = recentSummaries
            .filter(s => s.summaryJson)
            .map(s => ({
            date: s.digestDate,
            eventCount: s.eventCount,
            summary: s.summaryJson,
        }));
        // Separate questions
        const questions = todayEvents.filter(e => e.isQuestion);
        const prompt = `You are generating a Plato Inteligente nightly summary for ${profile.name || 'this user'}.

USER PROFILE:
${JSON.stringify(profile, null, 2)}

TODAY'S HEALTH EVENTS (chronological):
${JSON.stringify(todayFormatted, null, 2)}

${questions.length > 0 ? `QUESTIONS ASKED TODAY:\n${questions.map(q => `- "${q.rawInput}"`).join('\n')}\n` : ''}

LAST 7 DAYS SUMMARY:
${weekSummary}

${recentContext.length > 0 ? `PREVIOUS SUMMARIES:\n${JSON.stringify(recentContext, null, 2)}` : 'No previous summaries yet — this is an early day.'}

Generate the nightly summary following the 10-section Plato Inteligente structure.

SECTIONS REQUIRED (output as JSON):
{
  "greeting_name": "${profile.name || 'Amigo/a'}",
  "day_number": ${profile.dayCount},
  "date": "${new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}",
  "title_line1": "Tu dia tiene un patron.",
  "title_line2": "Hoy lo hicimos visible.",
  "meals": [
    {"time": "8:00am", "title": "Meal/event name in THEIR words", "bullets": ["One biological insight about this item"]}
  ],
  "signal_intro": "Bold statement about today's dominant signal",
  "signal_items": [
    {"direction": "up|down", "text": "specific input → specific result"}
  ],
  "signal_explanation": "2-3 sentences explaining the mechanism in plain language",
  "willpower_text": "4-5 lines reframing guilt as biology",
  "advantage_text": "Their personal leverage point — what they already do right + small amplification",
  "pattern_text": "Cross-day observation (or 'still observing' if early days)",
  ${questions.length > 0 ? `"questions": [{"question": "their exact question", "answer": "2-3 sentence answer in Frank voice"}],` : ''}
  "experiment_heading": "One specific experiment for tomorrow",
  "experiment_steps": ["Step 1", "Step 2", "Step 3"],
  "observe_text": "What to notice after the experiment",
  "footer_quote_1": "Revision: Dra. Hernandez",
  "footer_quote_2": "Tu Plato Inteligente"
}

RULES:
- Their words, not yours (use exact vocabulary from their messages)
- Mirror, don't lecture
- Biology, not willpower
- Frank Suarez coffee voice — warm, unhurried, plain language
- One insight per food, not a nutrition essay
- Affirm the instinct
- The Betrayal Test: would they feel seen or studied? If studied → rewrite
- ALL content in ${profile.language === 'en' ? 'English' : profile.language === 'pt' ? 'Portuguese' : profile.language === 'fr' ? 'French' : 'Spanish'}
- Output ONLY the JSON object, no markdown fences, no explanation`;
        try {
            const startTime = Date.now();
            const response = await this.client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 2000,
                messages: [{ role: 'user', content: prompt }],
            });
            const latencyMs = Date.now() - startTime;
            const content = response.content[0];
            if (content && content.type === 'text') {
                // Parse the JSON response
                let jsonText = content.text.trim();
                // Strip markdown fences if present
                if (jsonText.startsWith('```')) {
                    jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
                }
                try {
                    const summaryData = JSON.parse(jsonText);
                    // Log AI usage
                    const { logAIUsage } = await import('../../infra/logging/logger.js');
                    await logAIUsage({
                        userId: profile.name || 'unknown',
                        correlationId: `digest-${new Date().toISOString().split('T')[0]}`,
                        model: 'claude-haiku-4-5-20251001',
                        inputTokens: response.usage.input_tokens,
                        outputTokens: response.usage.output_tokens,
                        latencyMs,
                    });
                    return summaryData;
                }
                catch (parseErr) {
                    logger_1.logger.error({ error: parseErr, rawText: jsonText.substring(0, 500) }, 'Failed to parse Haiku summary JSON');
                    // Return raw text as fallback
                    return { raw_summary: content.text, parse_error: true };
                }
            }
            return { error: 'Empty response from Haiku' };
        }
        catch (error) {
            const err = error;
            logger_1.logger.error({ error: err.message }, 'Failed to generate summary with Haiku');
            throw error;
        }
    }
    /**
     * Load user profile from the database.
     */
    async loadUserProfile(userId, userName, language) {
        const userResult = await this.db.query('SELECT name, language, timezone, created_at FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        const createdAt = user?.created_at || new Date();
        const dayCount = Math.max(1, Math.ceil((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)));
        return {
            name: userName || user?.name || '',
            language: language || user?.language || 'es',
            timezone: user?.timezone || 'America/New_York',
            dayCount,
            communicationStyle: 'experiments', // Default — will be personalized over time
        };
    }
    /**
     * Get recent summaries for continuity context.
     */
    async getRecentSummaries(userId, limit = 3) {
        const result = await this.db.query(`SELECT * FROM daily_digests
       WHERE user_id = $1
       ORDER BY digest_date DESC
       LIMIT $2`, [userId, limit]);
        return result.rows.map(this.mapRow);
    }
    /**
     * Summarize a week of events into a concise string for the prompt.
     */
    summarizeWeekEvents(weekEvents, todayEvents) {
        // Exclude today's events (they're listed separately)
        const todayIds = new Set(todayEvents.map(e => e.id));
        const pastEvents = weekEvents.filter(e => !todayIds.has(e.id));
        if (pastEvents.length === 0) {
            return 'No previous days of data yet — this is their first day.';
        }
        // Group by date
        const byDate = new Map();
        for (const event of pastEvents) {
            const date = String(event.eventDate);
            if (!byDate.has(date))
                byDate.set(date, []);
            byDate.get(date).push(event);
        }
        const lines = [];
        for (const [date, events] of byDate) {
            const types = events.map(e => e.eventType || 'unknown').join(', ');
            const snippets = events
                .filter(e => e.rawInput)
                .map(e => (e.rawInput || '').substring(0, 80))
                .slice(0, 3);
            lines.push(`${date}: ${events.length} events (${types}) — ${snippets.join('; ')}`);
        }
        return lines.join('\n');
    }
    /**
     * Infer event type from raw input (simple heuristic).
     * The real classification happens in the Haiku call, but we need
     * something for the markProcessed call.
     */
    inferEventType(event) {
        if (!event.rawInput)
            return 'general';
        const lower = event.rawInput.toLowerCase();
        if (event.isQuestion)
            return 'question';
        if (event.imageUrl)
            return 'meal'; // Most images are food photos
        if (lower.includes('duele') || lower.includes('dolor') || lower.includes('pain') || lower.includes('hurt'))
            return 'symptom';
        if (lower.includes('medicin') || lower.includes('pastilla') || lower.includes('metformin') || lower.includes('pill'))
            return 'medication';
        if (lower.includes('lab') || lower.includes('resultado') || lower.includes('blood') || lower.includes('sangre'))
            return 'lab_result';
        if (lower.includes('dormi') || lower.includes('sleep') || lower.includes('sueño') || lower.includes('insomni'))
            return 'sleep';
        if (lower.includes('comí') || lower.includes('desayun') || lower.includes('almuerz') || lower.includes('cen') || lower.includes('arroz') || lower.includes('pollo'))
            return 'meal';
        return 'general';
    }
    /**
     * Save or update a daily digest.
     */
    async saveDigest(userId, dateStr, eventCount, pdfUrl, summaryJson) {
        const result = await this.db.query(`INSERT INTO daily_digests (id, user_id, digest_date, meal_count, pdf_url, pattern_summary, recommendations, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, digest_date)
       DO UPDATE SET meal_count = $3,
                     pdf_url = COALESCE($4, daily_digests.pdf_url),
                     pattern_summary = $5,
                     recommendations = $6
       RETURNING *`, [
            userId,
            dateStr,
            eventCount,
            pdfUrl,
            summaryJson ? JSON.stringify(summaryJson) : null,
            null, // recommendations — now embedded in summaryJson
        ]);
        return this.mapRow(result.rows[0]);
    }
    /**
     * Update the PDF URL after generation.
     */
    async updatePdfUrl(digestId, pdfUrl) {
        await this.db.query('UPDATE daily_digests SET pdf_url = $1 WHERE id = $2', [pdfUrl, digestId]);
    }
    /**
     * Get a specific daily digest.
     */
    async getDigest(userId, date) {
        const result = await this.db.query('SELECT * FROM daily_digests WHERE user_id = $1 AND digest_date = $2', [userId, date]);
        return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
    }
    mapRow(row) {
        return {
            id: row.id,
            userId: row.user_id,
            digestDate: row.digest_date,
            eventCount: row.meal_count, // Reusing column, now tracks all events
            pdfUrl: row.pdf_url,
            summaryJson: row.pattern_summary
                ? (typeof row.pattern_summary === 'string' ? JSON.parse(row.pattern_summary) : row.pattern_summary)
                : null,
            createdAt: row.created_at,
        };
    }
}
exports.DigestService = DigestService;
//# sourceMappingURL=service.js.map