/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 * Image-only messages skip AI entirely and use image templates.
 */
export declare function isQuestion(message: string): boolean;
/**
 * Generate a personalized ack that mirrors the user's message.
 * - Image-only messages: use template (no AI)
 * - Text messages: use Haiku (~$0.001) to mirror what they said
 * - Falls back to templates on any failure
 */
export declare function getSmartAck(userMessage: string, language: string, isQuestionMsg: boolean, hasImage?: boolean): Promise<string>;
/**
 * Pick a random fallback ack (no AI needed).
 */
export declare function getFallbackAck(language: string, isQuestionMsg: boolean): string;
export declare function getAckMessage(language: string, isQuestionMsg: boolean): string;
//# sourceMappingURL=ack-messages.d.ts.map