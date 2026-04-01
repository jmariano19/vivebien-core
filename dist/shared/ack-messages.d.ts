/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 * Image-only messages skip AI entirely and use image templates.
 */
export declare function isSocialMessage(message: string): boolean;
export declare function getSocialAck(language: string): string;
export declare function getQuestionAck(language: string): string;
export declare function isQuestion(message: string): boolean;
/**
 * Generate a personalized ack that mirrors the user's message.
 * - Social messages ("thanks", "ok", "yes"): warm 1-word reply, no AI
 * - Question messages: template that sets expectation (answer tonight), no AI
 * - Image-only messages: use template, no AI
 * - Food/health text: use Haiku (~$0.001) to mirror what they said
 * - Falls back to templates on any failure
 */
export declare function getSmartAck(userMessage: string, language: string, isQuestionMsg: boolean, hasImage?: boolean): Promise<string>;
/**
 * Pick a random fallback ack (no AI needed).
 */
export declare function getFallbackAck(language: string, isQuestionMsg: boolean): string;
export declare function getAckMessage(language: string, isQuestionMsg: boolean): string;
//# sourceMappingURL=ack-messages.d.ts.map