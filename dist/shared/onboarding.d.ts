/**
 * Plato Inteligente — Onboarding Questions + Archetype Scoring
 *
 * 5-question onboarding sequence sent one at a time via WhatsApp.
 * After question 5, answers are scored to detect the client's archetype.
 *
 * Archetypes:
 *   performance — self-initiates, wants mechanism, data-driven, fast adopter
 *   skeptic     — past failures, needs proof, slow trust, guarded
 *   curious     — asks WHY, engages but may not act, mechanism-driven
 *   passive     — low initiative, overwhelmed, needs simplicity
 */
import { Archetype, ArchetypeScores, OnboardingAnswer } from './types';
export declare const ONBOARDING_QUESTIONS: Record<string, string[]>;
export declare const ONBOARDING_INTRO: Record<string, string>;
export declare const ONBOARDING_COMPLETE: Record<string, string>;
export declare const ARCHETYPE_FIRST_IMPRESSION: Record<Archetype, Record<string, string>>;
/**
 * Derive the final archetype from accumulated scores across all 5 answers.
 */
export declare function detectArchetype(answers: OnboardingAnswer[]): {
    archetype: Archetype;
    scores: ArchetypeScores;
};
/**
 * Get the question text for a given step (1-5) and language.
 */
export declare function getQuestion(step: number, language: string): string;
/**
 * Get the intro message (sent before Q1) in the right language.
 */
export declare function getOnboardingIntro(language: string): string;
/**
 * Get the completion message (sent after Q5, before archetype message) in the right language.
 */
export declare function getOnboardingComplete(language: string): string;
/**
 * Get the archetype-specific first impression message.
 */
export declare function getArchetypeMessage(archetype: Archetype, language: string): string;
//# sourceMappingURL=onboarding.d.ts.map