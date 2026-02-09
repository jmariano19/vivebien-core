/**
 * Executes concern management commands against the database.
 * Handles merge, delete, and rename operations with fuzzy matching
 * and automatic legacy memory aggregation.
 */

import { Pool } from 'pg';
import { Logger } from 'pino';
import { ConcernService, HealthConcern } from './service';
import { findBestConcernMatch } from '../../shared/matching';

export class ConcernCommandExecutor {
  private concernService: ConcernService;

  constructor(
    private db: Pool,
    private logger: Logger
  ) {
    this.concernService = new ConcernService(db);
  }

  /**
   * Execute a merge command: combine two or more concerns into one.
   * Returns the actual matched concern names that were merged.
   */
  async executeMerge(userId: string, targetNames: string[]): Promise<string[]> {
    if (targetNames.length < 2) {
      throw new Error('Merge requires at least two concerns');
    }

    // Get active concerns for the user
    const activeConcerns = await this.concernService.getActiveConcerns(userId);

    // Fuzzy-match each target to an existing concern
    const matchedConcerns: HealthConcern[] = [];
    const matchedNames: string[] = [];

    for (const targetName of targetNames) {
      const matched = findBestConcernMatch(targetName, activeConcerns.map(c => c.title));
      if (!matched) {
        throw new Error(`Could not find concern matching: "${targetName}"`);
      }

      const concern = activeConcerns.find(c => c.title === matched);
      if (!concern) {
        throw new Error(`Concern not found: ${matched}`);
      }

      matchedConcerns.push(concern);
      matchedNames.push(concern.title);
    }

    // Use the first matched concern as the primary (merge into this one)
    const primaryConcern = matchedConcerns[0]!;
    const secondaryConcerns = matchedConcerns.slice(1);

    // Combine summaries: primary + secondary summaries
    let combinedSummary = primaryConcern.summaryContent || '';
    for (const secondary of secondaryConcerns) {
      if (secondary.summaryContent) {
        if (combinedSummary.length > 0) {
          combinedSummary += '\n\n';
        }
        combinedSummary += secondary.summaryContent;
      }
    }

    // Update the primary concern with the combined summary
    await this.concernService.updateConcernSummary(primaryConcern.id, combinedSummary, 'user_edit');

    // Delete secondary concerns
    for (const secondary of secondaryConcerns) {
      await this.concernService.deleteConcern(secondary.id);
    }

    // Update legacy memories table with aggregated active concerns
    await this.updateLegacyMemories(userId);

    this.logger.info(
      {
        userId,
        primaryConcernId: primaryConcern.id,
        mergedConcernIds: secondaryConcerns.map(c => c.id),
        matchedNames,
      },
      'Concerns merged'
    );

    return matchedNames;
  }

  /**
   * Execute a delete command: remove a concern from the user's records.
   * Returns the actual matched concern name that was deleted.
   */
  async executeDelete(userId: string, targetName: string): Promise<string[]> {
    // Get active concerns for the user
    const activeConcerns = await this.concernService.getActiveConcerns(userId);

    // Fuzzy-match the target to an existing concern
    const matched = findBestConcernMatch(targetName, activeConcerns.map(c => c.title));
    if (!matched) {
      throw new Error(`Could not find concern matching: "${targetName}"`);
    }

    const concern = activeConcerns.find(c => c.title === matched);
    if (!concern) {
      throw new Error(`Concern not found: ${matched}`);
    }

    // Delete the concern
    await this.concernService.deleteConcern(concern.id);

    // Update legacy memories table
    await this.updateLegacyMemories(userId);

    this.logger.info(
      {
        userId,
        deletedConcernId: concern.id,
        deletedTitle: concern.title,
      },
      'Concern deleted'
    );

    return [concern.title];
  }

  /**
   * Execute a rename command: change a concern's title.
   * Returns [oldTitle, newTitle] for confirmation messaging.
   */
  async executeRename(userId: string, targetName: string, newName: string): Promise<string[]> {
    // Get active concerns for the user
    const activeConcerns = await this.concernService.getActiveConcerns(userId);

    // Fuzzy-match the target to an existing concern
    const matched = findBestConcernMatch(targetName, activeConcerns.map(c => c.title));
    if (!matched) {
      throw new Error(`Could not find concern matching: "${targetName}"`);
    }

    const concern = activeConcerns.find(c => c.title === matched);
    if (!concern) {
      throw new Error(`Concern not found: ${matched}`);
    }

    // Rename the concern
    await this.concernService.renameConcern(concern.id, newName);

    this.logger.info(
      {
        userId,
        concernId: concern.id,
        oldTitle: concern.title,
        newTitle: newName,
      },
      'Concern renamed via command'
    );

    return [concern.title, newName];
  }

  /**
   * Update the legacy memories table with aggregated active concerns.
   * Fetches all active concerns and combines them into a single "health_summary" entry
   * with the format: "--- Title ---\n[content]\n\n--- Title ---\n[content]"
   */
  private async updateLegacyMemories(userId: string): Promise<void> {
    try {
      // Fetch all active concerns for this user
      const activeConcerns = await this.concernService.getActiveConcerns(userId);

      // Build aggregated summary
      const aggregatedLines: string[] = [];
      for (const concern of activeConcerns) {
        if (concern.summaryContent) {
          aggregatedLines.push(`--- ${concern.title} ---\n${concern.summaryContent}`);
        }
      }

      const aggregatedSummary = aggregatedLines.join('\n\n');

      // Upsert into memories table
      if (aggregatedSummary.length > 0) {
        await this.upsertMemorySummary(userId, aggregatedSummary);
      } else {
        // If no active concerns remain, clear the legacy summary
        await this.upsertMemorySummary(userId, '');
      }
    } catch (error) {
      this.logger.warn({ userId, error }, 'Failed to update legacy memories');
      // Don't throw - this is a best-effort operation
    }
  }

  /**
   * Upsert a health_summary entry into the memories table.
   */
  private async upsertMemorySummary(userId: string, content: string): Promise<void> {
    const existing = await this.db.query(
      `SELECT id FROM memories WHERE user_id = $1 AND category = 'health_summary'`,
      [userId]
    );

    if (existing.rows.length > 0) {
      await this.db.query(
        `UPDATE memories
         SET content = $1, created_at = NOW(), access_count = access_count + 1
         WHERE user_id = $2 AND category = 'health_summary'`,
        [content, userId]
      );
    } else {
      await this.db.query(
        `INSERT INTO memories (id, user_id, content, category, importance_score, created_at, access_count)
         VALUES (gen_random_uuid(), $1, $2, 'health_summary', 1.0, NOW(), 0)`,
        [userId, content]
      );
    }
  }
}
