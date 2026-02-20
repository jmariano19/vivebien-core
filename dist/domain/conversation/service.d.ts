import { Pool } from 'pg';
import { ConversationContext, Message, SafetyCheckResult } from '../../shared/types';
export declare class ConversationService {
    private db;
    constructor(db: Pool);
    loadContext(userId: string, conversationId: number): Promise<ConversationContext>;
    getRecentMessages(userId: string, limit?: number): Promise<Message[]>;
    /**
     * Get messages from the current conversation session only.
     * A "session" ends when there's a gap of more than `sessionGapHours` between messages.
     * This prevents old, unrelated conversations from polluting the current context
     * (e.g., headache messages from Monday leaking into a stomach pain conversation on Friday).
     */
    getSessionMessages(userId: string, limit?: number, sessionGapHours?: number): Promise<Message[]>;
    buildMessages(context: ConversationContext, newMessage: string): Promise<Message[]>;
    getHealthSummary(userId: string): Promise<string | null>;
    saveMessages(userId: string, conversationId: number, messages: Message[]): Promise<void>;
    updateState(userId: string, context: ConversationContext): Promise<void>;
    checkSafety(message: string, context: ConversationContext): Promise<SafetyCheckResult>;
    getTemplate(key: string, language?: string): Promise<string>;
    getSystemPrompt(context: ConversationContext, userLanguage?: string): Promise<string>;
    private getExperimentVariants;
    private determineNextPhase;
    private getDefaultTemplate;
    private getDefaultSystemPrompt;
}
//# sourceMappingURL=service.d.ts.map