export interface InboundJobData {
    type: 'inbound_message';
    correlationId: string;
    phone: string;
    message: string;
    conversationId: number;
    chatwootContactId: number;
    attachments?: Attachment[];
    timestamp: string;
}
export interface Attachment {
    type: 'audio' | 'image' | 'video' | 'document';
    url: string;
    mimeType?: string;
    fileName?: string;
}
export interface JobResult {
    status: 'completed' | 'failed' | 'skipped';
    correlationId: string;
    action?: string;
    error?: string;
    tokens?: TokenUsage;
}
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
}
export interface User {
    id: string;
    phone: string;
    name?: string;
    language: 'es' | 'en' | 'pt' | 'fr';
    timezone: string;
    createdAt: Date;
    isNew: boolean;
}
export interface BillingAccount {
    id: string;
    userId: string;
    credits: number;
    plan: 'free' | 'basic' | 'premium';
    status: 'active' | 'suspended' | 'cancelled';
}
export interface ConversationContext {
    userId: string;
    conversationId: number;
    phase: ConversationPhase;
    onboardingStep?: number;
    messageCount: number;
    lastMessageAt?: Date;
    promptVersion: string;
    experimentVariants: Record<string, string>;
    metadata: Record<string, unknown>;
    language?: string;
}
export type ConversationPhase = 'onboarding' | 'awaiting_name' | 'active' | 'paused' | 'completed' | 'crisis';
export type CheckinStatus = 'not_scheduled' | 'scheduled' | 'sent' | 'canceled' | 'completed';
export interface CheckinState {
    userId: string;
    status: CheckinStatus;
    scheduledFor?: Date;
    lastSummaryCreatedAt?: Date;
    lastUserMessageAt?: Date;
    lastBotMessageAt?: Date;
    caseLabel?: string;
}
export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: Date;
}
export interface SafetyCheckResult {
    isUrgent: boolean;
    type?: 'crisis' | 'self_harm' | 'danger' | 'medical_emergency';
    confidence: number;
    action?: string;
}
export interface CreditCheck {
    hasCredits: boolean;
    reservationId?: string;
    creditsRemaining: number;
}
export interface CreditCost {
    action: string;
    credits: number;
}
export interface AIResponse {
    content: string;
    usage: TokenUsage;
    model: string;
    latencyMs: number;
}
export interface PromptVersion {
    id: string;
    name: string;
    version: number;
    content: string;
    isActive: boolean;
}
export interface FeatureFlag {
    key: string;
    enabled: boolean;
    value?: unknown;
    description?: string;
}
export interface Experiment {
    key: string;
    variants: string[];
    weights: number[];
    enabled: boolean;
    description?: string;
}
export interface ConfigTemplate {
    key: string;
    contentEs: string;
    contentEn?: string;
    description?: string;
}
export interface ChatwootWebhookPayload {
    event: string;
    message_type: 'incoming' | 'outgoing';
    content?: string;
    conversation: {
        id: number;
        contact_inbox: {
            source_id: string;
        };
        meta?: {
            sender?: {
                name?: string;
            };
        };
    };
    sender?: {
        id: number;
        name?: string;
    };
    attachments?: Array<{
        file_type: string;
        data_url: string;
    }>;
}
export interface ApiResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    correlationId?: string;
}
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
    pagination: {
        page: number;
        limit: number;
        total: number;
        hasMore: boolean;
    };
}
export interface ExecutionLog {
    id: string;
    correlationId: string;
    jobId?: string;
    userId?: string;
    action: string;
    status: 'started' | 'completed' | 'failed';
    durationMs?: number;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    createdAt: Date;
}
//# sourceMappingURL=types.d.ts.map