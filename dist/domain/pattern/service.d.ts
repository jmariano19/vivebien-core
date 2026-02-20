import { Pool } from 'pg';
import { MealEvent } from '../meal/service';
export interface FoodPattern {
    id: string;
    userId: string;
    patternDescription: string;
    patternType: string | null;
    confidence: number;
    evidenceCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    createdAt: Date;
}
export declare class PatternService {
    private db;
    private client;
    private rateLimiter;
    constructor(db: Pool);
    /**
     * Generate food patterns from a set of meal events using Claude.
     * Feeds the week's meals + feelings to Claude and asks for cause-effect correlations.
     */
    generatePatterns(userId: string, meals: MealEvent[], language: string): Promise<string[]>;
    /**
     * Save detected patterns for a user, merging with existing ones
     */
    savePatterns(userId: string, patternDescriptions: string[]): Promise<void>;
    /**
     * Get recent patterns for a user
     */
    getRecentPatterns(userId: string, limit?: number): Promise<FoodPattern[]>;
    /**
     * Delete all patterns for a user (for testing/reset)
     */
    deleteAllPatterns(userId: string): Promise<void>;
}
//# sourceMappingURL=service.d.ts.map