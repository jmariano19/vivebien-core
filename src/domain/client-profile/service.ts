/**
 * Plato Inteligente — ClientProfileService
 *
 * Manages the client_profiles table:
 *   - Create profile on first message (archetype = unknown)
 *   - Save onboarding answers one by one
 *   - Set archetype after Q5
 *   - Track coaching phase + graduation
 *   - Update behavioral data over time
 */

import { Pool } from 'pg';
import { ClientProfile, Archetype, ArchetypeScores, CoachingPhase, OnboardingAnswer } from '../../shared/types';
import { logger } from '../../infra/logging/logger';

export class ClientProfileService {
  constructor(private pool: Pool) {}

  /**
   * Load a client profile. Returns null if not found.
   */
  async findByUserId(userId: string): Promise<ClientProfile | null> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      archetype: Archetype;
      archetype_scores: ArchetypeScores;
      coaching_phase: CoachingPhase;
      onboarding_answers: OnboardingAnswer[];
      patterns_confirmed: number;
      graduation_pending: boolean;
      graduated_at: Date | null;
      coach_notes: string | null;
      behavioral_data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, user_id, archetype, archetype_scores, coaching_phase,
              onboarding_answers, patterns_confirmed, graduation_pending,
              graduated_at, coach_notes, behavioral_data, created_at, updated_at
       FROM client_profiles
       WHERE user_id = $1`,
      [userId],
    );

    const row = result.rows[0];
    if (!row) return null;

    return this.mapRow(row);
  }

  /**
   * Create a profile for a new user (called when they send their first message).
   */
  async create(userId: string): Promise<ClientProfile> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      archetype: Archetype;
      archetype_scores: ArchetypeScores;
      coaching_phase: CoachingPhase;
      onboarding_answers: OnboardingAnswer[];
      patterns_confirmed: number;
      graduation_pending: boolean;
      graduated_at: Date | null;
      coach_notes: string | null;
      behavioral_data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO client_profiles (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, user_id, archetype, archetype_scores, coaching_phase,
                 onboarding_answers, patterns_confirmed, graduation_pending,
                 graduated_at, coach_notes, behavioral_data, created_at, updated_at`,
      [userId],
    );

    const profile = this.mapRow(result.rows[0]!);
    logger.info({ userId, profileId: profile.id }, 'Client profile created');
    return profile;
  }

  /**
   * Append an onboarding answer and save it to the profile.
   */
  async saveOnboardingAnswer(userId: string, question: number, answer: string): Promise<void> {
    const newAnswer: OnboardingAnswer = { question, answer };

    await this.pool.query(
      `UPDATE client_profiles
       SET onboarding_answers = onboarding_answers || $2::jsonb
       WHERE user_id = $1`,
      [userId, JSON.stringify(newAnswer)],
    );

    logger.info({ userId, question }, 'Onboarding answer saved');
  }

  /**
   * Set the final archetype after all 5 questions are answered.
   */
  async setArchetype(userId: string, archetype: Archetype, scores: ArchetypeScores): Promise<void> {
    await this.pool.query(
      `UPDATE client_profiles
       SET archetype = $2, archetype_scores = $3
       WHERE user_id = $1`,
      [userId, archetype, JSON.stringify(scores)],
    );

    logger.info({ userId, archetype, scores }, 'Archetype set');
  }

  /**
   * Increment the confirmed pattern count.
   * If count reaches 2, sets graduation_pending = TRUE automatically.
   */
  async incrementPatternsConfirmed(userId: string): Promise<{ patternsConfirmed: number; graduationPending: boolean }> {
    const result = await this.pool.query<{ patterns_confirmed: number; graduation_pending: boolean }>(
      `UPDATE client_profiles
       SET patterns_confirmed = patterns_confirmed + 1,
           graduation_pending = CASE WHEN patterns_confirmed + 1 >= 2 THEN TRUE ELSE graduation_pending END
       WHERE user_id = $1
       RETURNING patterns_confirmed, graduation_pending`,
      [userId],
    );

    const row = result.rows[0]!;
    logger.info({ userId, patternsConfirmed: row.patterns_confirmed, graduationPending: row.graduation_pending }, 'Pattern confirmed');
    return { patternsConfirmed: row.patterns_confirmed, graduationPending: row.graduation_pending };
  }

  /**
   * Upgrade client to phase_2 (called by Jeff via dashboard approval).
   */
  async graduateToPhase2(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE client_profiles
       SET coaching_phase = 'phase_2',
           graduation_pending = FALSE,
           graduated_at = NOW()
       WHERE user_id = $1`,
      [userId],
    );

    logger.info({ userId }, 'Client graduated to phase_2');
  }

  /**
   * Update Jeff's coach notes for a client.
   */
  async updateCoachNotes(userId: string, notes: string): Promise<void> {
    await this.pool.query(
      `UPDATE client_profiles SET coach_notes = $2 WHERE user_id = $1`,
      [userId, notes],
    );
  }

  /**
   * Update behavioral data (engagement level, response speed, etc.)
   * Merges with existing data — does not overwrite.
   */
  async updateBehavioralData(userId: string, data: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE client_profiles
       SET behavioral_data = behavioral_data || $2::jsonb
       WHERE user_id = $1`,
      [userId, JSON.stringify(data)],
    );
  }

  /**
   * Get all clients with graduation pending (for Jeff's dashboard).
   */
  async getPendingGraduations(): Promise<ClientProfile[]> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      archetype: Archetype;
      archetype_scores: ArchetypeScores;
      coaching_phase: CoachingPhase;
      onboarding_answers: OnboardingAnswer[];
      patterns_confirmed: number;
      graduation_pending: boolean;
      graduated_at: Date | null;
      coach_notes: string | null;
      behavioral_data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT cp.*, u.phone, u.name, u.language
       FROM client_profiles cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.graduation_pending = TRUE
       ORDER BY cp.updated_at DESC`,
    );

    return result.rows.map(row => this.mapRow(row));
  }

  /**
   * Get all client profiles with user info (for dashboard list).
   */
  async getAllClients(): Promise<Array<ClientProfile & { phone: string; name: string | null; language: string; lastEventAt: Date | null }>> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      archetype: Archetype;
      archetype_scores: ArchetypeScores;
      coaching_phase: CoachingPhase;
      onboarding_answers: OnboardingAnswer[];
      patterns_confirmed: number;
      graduation_pending: boolean;
      graduated_at: Date | null;
      coach_notes: string | null;
      behavioral_data: Record<string, unknown>;
      created_at: Date;
      updated_at: Date;
      phone: string;
      name: string | null;
      language: string;
      last_event_at: Date | null;
    }>(
      `SELECT cp.*,
              u.phone, u.name, u.language,
              MAX(he.created_at) AS last_event_at
       FROM client_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN health_events he ON he.user_id = cp.user_id
       GROUP BY cp.id, u.phone, u.name, u.language
       ORDER BY last_event_at DESC NULLS LAST`,
    );

    return result.rows.map(row => ({
      ...this.mapRow(row),
      phone: row.phone,
      name: row.name,
      language: row.language,
      lastEventAt: row.last_event_at,
    }));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private mapRow(row: {
    id: string;
    user_id: string;
    archetype: Archetype;
    archetype_scores: ArchetypeScores;
    coaching_phase: CoachingPhase;
    onboarding_answers: OnboardingAnswer[];
    patterns_confirmed: number;
    graduation_pending: boolean;
    graduated_at: Date | null;
    coach_notes: string | null;
    behavioral_data: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }): ClientProfile {
    return {
      id: row.id,
      userId: row.user_id,
      archetype: row.archetype,
      archetypeScores: row.archetype_scores,
      coachingPhase: row.coaching_phase,
      onboardingAnswers: row.onboarding_answers ?? [],
      patternsConfirmed: row.patterns_confirmed,
      graduationPending: row.graduation_pending,
      graduatedAt: row.graduated_at,
      coachNotes: row.coach_notes,
      behavioralData: row.behavioral_data ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
