import { Pool } from 'pg';
import { logger } from '../../infra/logging/logger';

export interface MealEvent {
  id: string;
  userId: string;
  mealType: string | null;
  description: string | null;
  imageUrl: string | null;
  feelingsBefore: string | null;
  feelingsAfter: string | null;
  aiAnalysis: string | null;
  nutrientsHint: string | null;
  createdAt: Date;
}

export interface CreateMealEventInput {
  mealType?: string;
  description?: string;
  imageUrl?: string;
  feelingsBefore?: string;
  aiAnalysis?: string;
}

export class MealService {
  constructor(private db: Pool) {}

  /**
   * Create a new meal event from a WhatsApp interaction.
   * Called after each message that involves food (photo, mention, etc.)
   */
  async createMealEvent(userId: string, input: CreateMealEventInput): Promise<MealEvent> {
    const mealType = input.mealType || this.inferMealTypeFromTime();

    const result = await this.db.query<{
      id: string;
      user_id: string;
      meal_type: string | null;
      description: string | null;
      image_url: string | null;
      feelings_before: string | null;
      feelings_after: string | null;
      ai_analysis: string | null;
      nutrients_hint: string | null;
      created_at: Date;
    }>(
      `INSERT INTO meal_events (id, user_id, meal_type, description, image_url, feelings_before, ai_analysis, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [userId, mealType, input.description || null, input.imageUrl || null, input.feelingsBefore || null, input.aiAnalysis || null]
    );

    const row = result.rows[0]!;
    return this.mapRow(row);
  }

  /**
   * Get all meal events for a specific date
   */
  async getMealEventsForDay(userId: string, date: Date): Promise<MealEvent[]> {
    const dateStr = date.toISOString().split('T')[0];
    const result = await this.db.query(
      `SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at::date = $2
       ORDER BY created_at ASC`,
      [userId, dateStr]
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Get meal events within a date range
   */
  async getMealEvents(userId: string, startDate: Date, endDate: Date): Promise<MealEvent[]> {
    const result = await this.db.query(
      `SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
       ORDER BY created_at ASC`,
      [userId, startDate.toISOString(), endDate.toISOString()]
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Get recent meal events (last N days)
   */
  async getRecentMeals(userId: string, days: number = 7): Promise<MealEvent[]> {
    const result = await this.db.query(
      `SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
       ORDER BY created_at DESC`,
      [userId, days]
    );
    return result.rows.map(this.mapRow);
  }

  /**
   * Update feelings_after for a meal event (e.g., when user reports how they feel later)
   */
  async updateFeelingsAfter(mealEventId: string, userId: string, feelings: string): Promise<void> {
    await this.db.query(
      `UPDATE meal_events SET feelings_after = $1 WHERE id = $2 AND user_id = $3`,
      [feelings, mealEventId, userId]
    );
  }

  /**
   * Count meals for a user on a specific date
   */
  async countMealsForDay(userId: string, date: Date): Promise<number> {
    const dateStr = date.toISOString().split('T')[0];
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM meal_events WHERE user_id = $1 AND created_at::date = $2`,
      [userId, dateStr]
    );
    return parseInt(result.rows[0]?.count || '0', 10);
  }

  /**
   * Get all users who have meal events today (for digest generation)
   */
  async getUsersWithMealsToday(): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM meal_events WHERE created_at::date = CURRENT_DATE`
    );
    return result.rows.map(r => r.user_id);
  }

  /**
   * Detect meal type from message content and user's language
   */
  detectMealType(message: string, language: string): string | null {
    const lower = message.toLowerCase();

    const keywords: Record<string, Record<string, string>> = {
      breakfast: {
        es: 'desayuno|desayunar|desayuné',
        en: 'breakfast|morning meal',
        pt: 'café da manhã|desjejum',
        fr: 'petit-déjeuner|petit déjeuner',
      },
      lunch: {
        es: 'almuerzo|almorzar|almorcé|comida del mediodía',
        en: 'lunch|midday meal',
        pt: 'almoço|almocei',
        fr: 'déjeuner',
      },
      dinner: {
        es: 'cena|cenar|cené|comida de la noche',
        en: 'dinner|supper|evening meal',
        pt: 'jantar|jantei',
        fr: 'dîner|souper',
      },
      snack: {
        es: 'merienda|snack|antojo|botana',
        en: 'snack|bite|treat',
        pt: 'lanche|merenda',
        fr: 'goûter|collation|en-cas',
      },
    };

    for (const [mealType, langPatterns] of Object.entries(keywords)) {
      for (const [lang, pattern] of Object.entries(langPatterns)) {
        if (new RegExp(pattern, 'i').test(lower)) {
          return mealType;
        }
      }
    }

    return null;
  }

  /**
   * Infer meal type from current time of day
   */
  private inferMealTypeFromTime(): string {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return 'breakfast';
    if (hour >= 11 && hour < 15) return 'lunch';
    if (hour >= 15 && hour < 18) return 'snack';
    if (hour >= 18 && hour < 23) return 'dinner';
    return 'snack'; // late night
  }

  private mapRow(row: any): MealEvent {
    return {
      id: row.id,
      userId: row.user_id,
      mealType: row.meal_type,
      description: row.description,
      imageUrl: row.image_url,
      feelingsBefore: row.feelings_before,
      feelingsAfter: row.feelings_after,
      aiAnalysis: row.ai_analysis,
      nutrientsHint: row.nutrients_hint,
      createdAt: row.created_at,
    };
  }
}
