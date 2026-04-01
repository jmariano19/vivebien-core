"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientProfileService = void 0;
const logger_1 = require("../../infra/logging/logger");
class ClientProfileService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Load a client profile. Returns null if not found.
     */
    async findByUserId(userId) {
        const result = await this.pool.query(`SELECT id, user_id, archetype, archetype_scores, coaching_phase,
              onboarding_answers, patterns_confirmed, graduation_pending,
              graduated_at, coach_notes, behavioral_data, created_at, updated_at
       FROM client_profiles
       WHERE user_id = $1`, [userId]);
        const row = result.rows[0];
        if (!row)
            return null;
        return this.mapRow(row);
    }
    /**
     * Create a profile for a new user (called when they send their first message).
     */
    async create(userId) {
        const result = await this.pool.query(`INSERT INTO client_profiles (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, user_id, archetype, archetype_scores, coaching_phase,
                 onboarding_answers, patterns_confirmed, graduation_pending,
                 graduated_at, coach_notes, behavioral_data, created_at, updated_at`, [userId]);
        const profile = this.mapRow(result.rows[0]);
        logger_1.logger.info({ userId, profileId: profile.id }, 'Client profile created');
        return profile;
    }
    /**
     * Append an onboarding answer and save it to the profile.
     */
    async saveOnboardingAnswer(userId, question, answer) {
        const newAnswer = { question, answer };
        await this.pool.query(`UPDATE client_profiles
       SET onboarding_answers = onboarding_answers || $2::jsonb
       WHERE user_id = $1`, [userId, JSON.stringify(newAnswer)]);
        logger_1.logger.info({ userId, question }, 'Onboarding answer saved');
    }
    /**
     * Set the final archetype after all 5 questions are answered.
     */
    async setArchetype(userId, archetype, scores) {
        await this.pool.query(`UPDATE client_profiles
       SET archetype = $2, archetype_scores = $3
       WHERE user_id = $1`, [userId, archetype, JSON.stringify(scores)]);
        logger_1.logger.info({ userId, archetype, scores }, 'Archetype set');
    }
    /**
     * Increment the confirmed pattern count.
     * If count reaches 2, sets graduation_pending = TRUE automatically.
     */
    async incrementPatternsConfirmed(userId) {
        const result = await this.pool.query(`UPDATE client_profiles
       SET patterns_confirmed = patterns_confirmed + 1,
           graduation_pending = CASE WHEN patterns_confirmed + 1 >= 2 THEN TRUE ELSE graduation_pending END
       WHERE user_id = $1
       RETURNING patterns_confirmed, graduation_pending`, [userId]);
        const row = result.rows[0];
        logger_1.logger.info({ userId, patternsConfirmed: row.patterns_confirmed, graduationPending: row.graduation_pending }, 'Pattern confirmed');
        return { patternsConfirmed: row.patterns_confirmed, graduationPending: row.graduation_pending };
    }
    /**
     * Upgrade client to phase_2 (called by Jeff via dashboard approval).
     */
    async graduateToPhase2(userId) {
        await this.pool.query(`UPDATE client_profiles
       SET coaching_phase = 'phase_2',
           graduation_pending = FALSE,
           graduated_at = NOW()
       WHERE user_id = $1`, [userId]);
        logger_1.logger.info({ userId }, 'Client graduated to phase_2');
    }
    /**
     * Update Jeff's coach notes for a client.
     */
    async updateCoachNotes(userId, notes) {
        await this.pool.query(`UPDATE client_profiles SET coach_notes = $2 WHERE user_id = $1`, [userId, notes]);
    }
    /**
     * Update behavioral data (engagement level, response speed, etc.)
     * Merges with existing data — does not overwrite.
     */
    async updateBehavioralData(userId, data) {
        await this.pool.query(`UPDATE client_profiles
       SET behavioral_data = behavioral_data || $2::jsonb
       WHERE user_id = $1`, [userId, JSON.stringify(data)]);
    }
    /**
     * Get all clients with graduation pending (for Jeff's dashboard).
     */
    async getPendingGraduations() {
        const result = await this.pool.query(`SELECT cp.*, u.phone, u.name, u.language
       FROM client_profiles cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.graduation_pending = TRUE
       ORDER BY cp.updated_at DESC`);
        return result.rows.map(row => this.mapRow(row));
    }
    /**
     * Get all client profiles with user info (for dashboard list).
     */
    async getAllClients() {
        const result = await this.pool.query(`SELECT cp.*,
              u.phone, u.name, u.language,
              MAX(he.created_at) AS last_event_at
       FROM client_profiles cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN health_events he ON he.user_id = cp.user_id
       GROUP BY cp.id, u.phone, u.name, u.language
       ORDER BY last_event_at DESC NULLS LAST`);
        return result.rows.map(row => ({
            ...this.mapRow(row),
            phone: row.phone,
            name: row.name,
            language: row.language,
            lastEventAt: row.last_event_at,
        }));
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    mapRow(row) {
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
exports.ClientProfileService = ClientProfileService;
//# sourceMappingURL=service.js.map