"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MealService = void 0;
class MealService {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new meal event from a WhatsApp interaction.
     * Called after each message that involves food (photo, mention, etc.)
     */
    async createMealEvent(userId, input) {
        const mealType = input.mealType || this.inferMealTypeFromTime();
        const result = await this.db.query(`INSERT INTO meal_events (id, user_id, meal_type, description, image_url, feelings_before, ai_analysis, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`, [userId, mealType, input.description || null, input.imageUrl || null, input.feelingsBefore || null, input.aiAnalysis || null]);
        const row = result.rows[0];
        return this.mapRow(row);
    }
    /**
     * Get all meal events for a specific date
     */
    async getMealEventsForDay(userId, date) {
        const dateStr = date.toISOString().split('T')[0];
        const result = await this.db.query(`SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at::date = $2
       ORDER BY created_at ASC`, [userId, dateStr]);
        return result.rows.map(this.mapRow);
    }
    /**
     * Get meal events within a date range
     */
    async getMealEvents(userId, startDate, endDate) {
        const result = await this.db.query(`SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
       ORDER BY created_at ASC`, [userId, startDate.toISOString(), endDate.toISOString()]);
        return result.rows.map(this.mapRow);
    }
    /**
     * Get recent meal events (last N days)
     */
    async getRecentMeals(userId, days = 7) {
        const result = await this.db.query(`SELECT * FROM meal_events
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 day' * $2
       ORDER BY created_at DESC`, [userId, days]);
        return result.rows.map(this.mapRow);
    }
    /**
     * Update feelings_after for a meal event (e.g., when user reports how they feel later)
     */
    async updateFeelingsAfter(mealEventId, userId, feelings) {
        await this.db.query(`UPDATE meal_events SET feelings_after = $1 WHERE id = $2 AND user_id = $3`, [feelings, mealEventId, userId]);
    }
    /**
     * Count meals for a user on a specific date
     */
    async countMealsForDay(userId, date) {
        const dateStr = date.toISOString().split('T')[0];
        const result = await this.db.query(`SELECT COUNT(*) as count FROM meal_events WHERE user_id = $1 AND created_at::date = $2`, [userId, dateStr]);
        return parseInt(result.rows[0]?.count || '0', 10);
    }
    /**
     * Get all users who have meal events today (for digest generation)
     */
    async getUsersWithMealsToday() {
        const result = await this.db.query(`SELECT DISTINCT user_id FROM meal_events WHERE created_at::date = CURRENT_DATE`);
        return result.rows.map(r => r.user_id);
    }
    /**
     * Detect meal type from message content and user's language
     */
    detectMealType(message, language) {
        const lower = message.toLowerCase();
        const keywords = {
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
    inferMealTypeFromTime() {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 11)
            return 'breakfast';
        if (hour >= 11 && hour < 15)
            return 'lunch';
        if (hour >= 15 && hour < 18)
            return 'snack';
        if (hour >= 18 && hour < 23)
            return 'dinner';
        return 'snack'; // late night
    }
    mapRow(row) {
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
exports.MealService = MealService;
//# sourceMappingURL=service.js.map