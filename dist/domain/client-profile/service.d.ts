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
import { ClientProfile, Archetype, ArchetypeScores } from '../../shared/types';
export declare class ClientProfileService {
    private pool;
    constructor(pool: Pool);
    /**
     * Load a client profile. Returns null if not found.
     */
    findByUserId(userId: string): Promise<ClientProfile | null>;
    /**
     * Create a profile for a new user (called when they send their first message).
     */
    create(userId: string): Promise<ClientProfile>;
    /**
     * Append an onboarding answer and save it to the profile.
     */
    saveOnboardingAnswer(userId: string, question: number, answer: string): Promise<void>;
    /**
     * Set the final archetype after all 5 questions are answered.
     */
    setArchetype(userId: string, archetype: Archetype, scores: ArchetypeScores): Promise<void>;
    /**
     * Increment the confirmed pattern count.
     * If count reaches 2, sets graduation_pending = TRUE automatically.
     */
    incrementPatternsConfirmed(userId: string): Promise<{
        patternsConfirmed: number;
        graduationPending: boolean;
    }>;
    /**
     * Upgrade client to phase_2 (called by Jeff via dashboard approval).
     */
    graduateToPhase2(userId: string): Promise<void>;
    /**
     * Update Jeff's coach notes for a client.
     */
    updateCoachNotes(userId: string, notes: string): Promise<void>;
    /**
     * Update behavioral data (engagement level, response speed, etc.)
     * Merges with existing data — does not overwrite.
     */
    updateBehavioralData(userId: string, data: Record<string, unknown>): Promise<void>;
    /**
     * Get all clients with graduation pending (for Jeff's dashboard).
     */
    getPendingGraduations(): Promise<ClientProfile[]>;
    /**
     * Get all client profiles with user info (for dashboard list).
     */
    getAllClients(): Promise<Array<ClientProfile & {
        phone: string;
        name: string | null;
        language: string;
        lastEventAt: Date | null;
    }>>;
    private mapRow;
}
//# sourceMappingURL=service.d.ts.map