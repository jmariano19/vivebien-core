import { Message } from './types';
/**
 * Detect the language of a message based on common word patterns.
 * Returns 'es', 'en', 'pt', 'fr' or null if uncertain.
 */
export declare function detectLanguage(message: string): 'es' | 'en' | 'pt' | 'fr' | null;
/**
 * Extract user name from message text, checking both proactive patterns
 * ("je m'appelle Marie") and responses to AI name-ask questions.
 */
export declare function extractUserName(userMessage: string, recentMessages: Message[]): string | null;
/**
 * Backup name extraction from AI response acknowledgments.
 * e.g. "Merci Marie, c'est très utile" → "Marie"
 */
export declare function extractNameFromAIResponse(aiResponse: string): string | null;
//# sourceMappingURL=language.d.ts.map