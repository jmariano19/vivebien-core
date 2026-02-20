"use strict";
/**
 * Plato Inteligente — HealthEventService
 *
 * Phase 1 (inbound): saves raw user input to health_events with processed=FALSE.
 * Phase 2 (nightly): the nightly pipeline fills event_type + extracted_data.
 *
 * Zero AI calls during the day. All intelligence concentrated at night.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthEventService = void 0;
const logger_1 = require("../../infra/logging/logger");
// ============================================================================
// Service
// ============================================================================
class HealthEventService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Save a raw health event — no AI, no classification.
     * event_type stays NULL until the nightly pipeline processes it.
     */
    async saveEvent(input) {
        const { userId, rawInput, imageUrl = null, language = null, isQuestion = false, source = 'whatsapp', } = input;
        try {
            const result = await this.pool.query(`INSERT INTO health_events
         (user_id, raw_input, image_url, language, is_question, source)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING
           id,
           user_id       AS "userId",
           event_type    AS "eventType",
           event_time    AS "eventTime",
           event_date    AS "eventDate",
           raw_input     AS "rawInput",
           image_url     AS "imageUrl",
           extracted_data AS "extractedData",
           is_question   AS "isQuestion",
           processed,
           source,
           language,
           created_at    AS "createdAt"`, [userId, rawInput, imageUrl, language, isQuestion, source]);
            const event = result.rows[0];
            logger_1.logger.info({ eventId: event.id, userId, isQuestion, source }, 'Health event saved');
            return event;
        }
        catch (error) {
            const err = error;
            logger_1.logger.error({ userId, error: err.message }, 'Failed to save health event');
            throw error;
        }
    }
    /**
     * Get all unprocessed events for a user on a given date.
     * Used by the nightly pipeline to batch-process the day's inputs.
     */
    async getUnprocessedEvents(userId, date) {
        const targetDate = date || new Date().toISOString().split('T')[0];
        const result = await this.pool.query(`SELECT
         id,
         user_id       AS "userId",
         event_type    AS "eventType",
         event_time    AS "eventTime",
         event_date    AS "eventDate",
         raw_input     AS "rawInput",
         image_url     AS "imageUrl",
         extracted_data AS "extractedData",
         is_question   AS "isQuestion",
         processed,
         source,
         language,
         created_at    AS "createdAt"
       FROM health_events
       WHERE user_id = $1
         AND event_date = $2
         AND processed = FALSE
       ORDER BY event_time ASC`, [userId, targetDate]);
        return result.rows;
    }
    /**
     * Get events for a date range (used for weekly summaries / pattern detection).
     */
    async getEventsByDateRange(userId, startDate, endDate) {
        const result = await this.pool.query(`SELECT
         id,
         user_id       AS "userId",
         event_type    AS "eventType",
         event_time    AS "eventTime",
         event_date    AS "eventDate",
         raw_input     AS "rawInput",
         image_url     AS "imageUrl",
         extracted_data AS "extractedData",
         is_question   AS "isQuestion",
         processed,
         source,
         language,
         created_at    AS "createdAt"
       FROM health_events
       WHERE user_id = $1
         AND event_date BETWEEN $2 AND $3
       ORDER BY event_time ASC`, [userId, startDate, endDate]);
        return result.rows;
    }
    /**
     * Mark events as processed after the nightly pipeline runs.
     * Also fills in event_type and extracted_data from the AI analysis.
     */
    async markProcessed(eventId, eventType, extractedData) {
        await this.pool.query(`UPDATE health_events
       SET processed = TRUE,
           event_type = $2,
           extracted_data = $3
       WHERE id = $1`, [eventId, eventType, JSON.stringify(extractedData)]);
    }
    /**
     * Count today's events for a user (useful for ack message variation).
     */
    async countTodayEvents(userId) {
        const result = await this.pool.query(`SELECT COUNT(*) AS count
       FROM health_events
       WHERE user_id = $1
         AND event_date = CURRENT_DATE`, [userId]);
        return parseInt(result.rows[0]?.count || '0', 10);
    }
}
exports.HealthEventService = HealthEventService;
//# sourceMappingURL=service.js.map