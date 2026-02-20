import { Pool } from 'pg';
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
export declare class MealService {
    private db;
    constructor(db: Pool);
    /**
     * Create a new meal event from a WhatsApp interaction.
     * Called after each message that involves food (photo, mention, etc.)
     */
    createMealEvent(userId: string, input: CreateMealEventInput): Promise<MealEvent>;
    /**
     * Get all meal events for a specific date
     */
    getMealEventsForDay(userId: string, date: Date): Promise<MealEvent[]>;
    /**
     * Get meal events within a date range
     */
    getMealEvents(userId: string, startDate: Date, endDate: Date): Promise<MealEvent[]>;
    /**
     * Get recent meal events (last N days)
     */
    getRecentMeals(userId: string, days?: number): Promise<MealEvent[]>;
    /**
     * Update feelings_after for a meal event (e.g., when user reports how they feel later)
     */
    updateFeelingsAfter(mealEventId: string, userId: string, feelings: string): Promise<void>;
    /**
     * Count meals for a user on a specific date
     */
    countMealsForDay(userId: string, date: Date): Promise<number>;
    /**
     * Get all users who have meal events today (for digest generation)
     */
    getUsersWithMealsToday(): Promise<string[]>;
    /**
     * Detect meal type from message content and user's language
     */
    detectMealType(message: string, language: string): string | null;
    /**
     * Infer meal type from current time of day
     */
    private inferMealTypeFromTime;
    private mapRow;
}
//# sourceMappingURL=service.d.ts.map