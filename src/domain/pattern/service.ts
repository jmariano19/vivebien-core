import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { logger } from '../../infra/logging/logger';
import { MealEvent } from '../meal/service';
import { RateLimiter } from '../../shared/rate-limiter';

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

export class PatternService {
  private client: Anthropic;
  private rateLimiter: RateLimiter;

  constructor(private db: Pool) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.rateLimiter = new RateLimiter({ maxRequestsPerMinute: config.claudeRpmLimit });
  }

  /**
   * Generate food patterns from a set of meal events using Claude.
   * Feeds the week's meals + feelings to Claude and asks for cause-effect correlations.
   */
  async generatePatterns(userId: string, meals: MealEvent[], language: string): Promise<string[]> {
    if (meals.length < 3) {
      logger.info({ userId, mealCount: meals.length }, 'Not enough meals to detect patterns');
      return [];
    }

    await this.rateLimiter.acquire();

    const langName = language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English';

    // Build meal timeline for Claude
    const mealTimeline = meals.map(m => {
      const date = m.createdAt.toISOString().split('T')[0];
      const time = m.createdAt.toTimeString().substring(0, 5);
      const parts = [`[${date} ${time}] ${m.mealType || 'meal'}`];
      if (m.description) parts.push(`Description: ${m.description}`);
      if (m.aiAnalysis) parts.push(`Food analysis: ${m.aiAnalysis}`);
      if (m.feelingsBefore) parts.push(`Feeling before: ${m.feelingsBefore}`);
      if (m.feelingsAfter) parts.push(`Feeling after: ${m.feelingsAfter}`);
      return parts.join('\n  ');
    }).join('\n\n');

    const prompt = `You are a nutrition pattern analyst. Analyze this person's meal history and identify cause-effect patterns between what they eat and how they feel.

MEAL HISTORY:
${mealTimeline}

RULES:
- Only identify patterns with real evidence (at least 2 occurrences)
- Focus on food → feeling correlations: "when you eat X, you tend to feel Y"
- Include timing patterns: "eating late tends to..."
- Include positive patterns too: "days when you eat beans, your energy is better"
- Keep each pattern to 1-2 sentences max
- Write in ${langName}
- Be warm and non-judgmental (no guilt)
- Maximum 5 patterns
- If there aren't enough data points for reliable patterns, say so honestly

Return ONLY the patterns, one per line, no numbering or bullets. If no patterns are detectable, return "NO_PATTERNS".`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => ('text' in block ? block.text : ''))
        .join('\n')
        .trim();

      if (content === 'NO_PATTERNS' || !content) {
        return [];
      }

      // Split into individual patterns
      const patterns = content.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 10); // Filter out empty or very short lines

      return patterns;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to generate food patterns');
      return [];
    }
  }

  /**
   * Save detected patterns for a user, merging with existing ones
   */
  async savePatterns(userId: string, patternDescriptions: string[]): Promise<void> {
    if (patternDescriptions.length === 0) return;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const description of patternDescriptions) {
        // Check if a similar pattern already exists (fuzzy match)
        const existing = await client.query<{ id: string; evidence_count: number }>(
          `SELECT id, evidence_count FROM food_patterns
           WHERE user_id = $1 AND LOWER(pattern_description) LIKE '%' || LOWER($2) || '%'
           LIMIT 1`,
          [userId, description.substring(0, 50)]
        );

        if (existing.rows.length > 0) {
          // Update existing pattern
          await client.query(
            `UPDATE food_patterns
             SET evidence_count = evidence_count + 1,
                 last_seen_at = NOW(),
                 confidence = LEAST(1.0, confidence + 0.1)
             WHERE id = $1`,
            [existing.rows[0]!.id]
          );
        } else {
          // Create new pattern
          await client.query(
            `INSERT INTO food_patterns (id, user_id, pattern_description, confidence, evidence_count, first_seen_at, last_seen_at, created_at)
             VALUES (gen_random_uuid(), $1, $2, 0.5, 1, NOW(), NOW(), NOW())`,
            [userId, description]
          );
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get recent patterns for a user
   */
  async getRecentPatterns(userId: string, limit: number = 10): Promise<FoodPattern[]> {
    const result = await this.db.query(
      `SELECT * FROM food_patterns
       WHERE user_id = $1
       ORDER BY confidence DESC, last_seen_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      patternDescription: row.pattern_description,
      patternType: row.pattern_type,
      confidence: parseFloat(row.confidence),
      evidenceCount: row.evidence_count,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete all patterns for a user (for testing/reset)
   */
  async deleteAllPatterns(userId: string): Promise<void> {
    await this.db.query('DELETE FROM food_patterns WHERE user_id = $1', [userId]);
  }
}
