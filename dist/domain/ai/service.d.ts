import { AIResponse, Message, ConversationContext } from '../../shared/types';
export declare class AIService {
    private client;
    private rateLimiter;
    constructor();
    generateResponse(messages: Message[], context: ConversationContext, userId: string, correlationId: string): Promise<AIResponse>;
    /**
     * Post-process AI response to clean up formatting
     * Basic cleaning only — containment + link are added by the handler
     */
    postProcess(content: string): string;
    /**
     * Split a summary response into acknowledgment + health note parts.
     * Returns null if response doesn't contain a splittable summary.
     */
    splitSummaryResponse(content: string): {
        acknowledgment: string;
        summary: string;
    } | null;
    /**
     * Strip AI-generated containment/continuity text to prevent duplication
     */
    private stripContainmentText;
    /**
     * Build the formatted summary message with containment + link.
     * When concernTitle is provided, prepend a header showing which concern this note belongs to.
     */
    buildSummaryMessage(summary: string, userId: string, language: string, concernTitle?: string | null): string;
    /**
     * Extract the concern topic from a health note's Concern/Motivo/Queixa field.
     * More reliable than detectConcernTitle for corrections, because it reads
     * what the AI actually wrote rather than guessing from conversation history.
     * Returns a short title (2-5 words) or null if not found.
     */
    extractConcernFromNote(content: string): string | null;
    /**
     * Check if the response looks like a summary
     */
    looksLikeSummary(content: string): boolean;
    /**
     * Get containment reinforcement text — emotionally critical
     * Appended after every summary to offload mental burden
     * "You don't need to remember this — it's saved."
     */
    private getContainmentText;
    /**
     * Get the summary link text in the appropriate language
     * Only shown after summaries, not on every message
     * Reinforces containment: the note is safely saved and accessible
     */
    private getSummaryLinkText;
    /**
     * Get the name ask message for post-summary delivery
     * Sent as a separate message after the health note to feel natural
     */
    getNameAskMessage(language: string): string;
    /**
     * Generate a simple response without full context (for quick replies)
     */
    generateQuickResponse(prompt: string): Promise<string>;
    /**
     * Generate or update a health summary based on conversation history
     * This creates a live summary that can be displayed on a website
     */
    generateSummary(messages: Message[], currentSummary: string | null, language?: string, focusTopic?: string, otherTopics?: string[]): Promise<string>;
    /**
     * Detect the main health concern topic from conversation messages.
     * Uses Claude Haiku for fast, lightweight extraction.
     * Returns a short title like "Back pain", "Eye sty", "Headaches"
     */
    detectConcernTitle(messages: Message[], language?: string, existingConcernTitles?: string[]): Promise<string>;
}
//# sourceMappingURL=service.d.ts.map