/**
 * Plato Inteligente — HealthEventService
 *
 * Phase 1 (inbound): saves raw user input to health_events with processed=FALSE.
 * Phase 2 (nightly): the nightly pipeline fills event_type + extracted_data.
 *
 * Zero AI calls during the day. All intelligence concentrated at night.
 */

import { Pool } from 'pg';
import { logger } from '../../infra/logging/logger';

// ============================================================================
// Types
// ============================================================================

export interface HealthEvent {
  id: string;
  userId: string;
  eventType: string | null;
  eventTime: Date;
  eventDate: string;
  rawInput: string | null;
  imageUrl: string | null;
  extractedData: Record<string, unknown>;
  isQuestion: boolean;
  processed: boolean;
  source: string;
  language: string | null;
  createdAt: Date;
}

export interface SaveEventInput {
  userId: string;
  rawInput: string | null;
  imageUrl?: string | null;
  language?: string | null;
  isQuestion?: boolean;
  source?: string;
}

// ============================================================================
// Service
// ============================================================================

export class HealthEventService {
  constructor(private pool: Pool) {}

  /**
   * Save a raw health event — no AI, no classification.
   * event_type stays NULL until the nightly pipeline processes it.
   */
  async saveEvent(input: SaveEventInput): Promise<HealthEvent> {
    const {
      userId,
      rawInput,
      imageUrl = null,
      language = null,
      isQuestion = false,
      source = 'whatsapp',
    } = input;

    try {
      const result = await this.pool.query<HealthEvent>(
        `INSERT INTO health_events
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
           created_at    AS "createdAt"`,
        [userId, rawInput, imageUrl, language, isQuestion, source],
      );

      const event = result.rows[0]!;
      logger.info(
        { eventId: event.id, userId, isQuestion, source },
        'Health event saved',
      );

      return event;
    } catch (error) {
      const err = error as Error;
      logger.error(
        { userId, error: err.message },
        'Failed to save health event',
      );
      throw error;
    }
  }

  /**
   * Get all unprocessed events for a user on a given date.
   * Used by the nightly pipeline to batch-process the day's inputs.
   */
  async getUnprocessedEvents(
    userId: string,
    date?: string,
  ): Promise<HealthEvent[]> {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const result = await this.pool.query<HealthEvent>(
      `SELECT
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
       ORDER BY event_time ASC`,
      [userId, targetDate],
    );

    return result.rows;
  }

  /**
   * Get events for a date range (used for weekly summaries / pattern detection).
   */
  async getEventsByDateRange(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<HealthEvent[]> {
    const result = await this.pool.query<HealthEvent>(
      `SELECT
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
       ORDER BY event_time ASC`,
      [userId, startDate, endDate],
    );

    return result.rows;
  }

  /**
   * Mark events as processed after the nightly pipeline runs.
   * Also fills in event_type and extracted_data from the AI analysis.
   */
  async markProcessed(
    eventId: string,
    eventType: string,
    extractedData: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE health_events
       SET processed = TRUE,
           event_type = $2,
           extracted_data = $3
       WHERE id = $1`,
      [eventId, eventType, JSON.stringify(extractedData)],
    );
  }

  /**
   * Count today's events for a user (useful for ack message variation).
   */
  async countTodayEvents(userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM health_events
       WHERE user_id = $1
         AND event_date = CURRENT_DATE`,
      [userId],
    );

    return parseInt(result.rows[0]?.count || '0', 10);
  }
}
