"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIService = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../../config");
const errors_1 = require("../../shared/errors");
const logger_1 = require("../../infra/logging/logger");
const service_1 = require("../conversation/service");
const client_1 = require("../../infra/db/client");
const rate_limiter_1 = require("../../shared/rate-limiter");
const language_1 = require("../../shared/language");
const conversationService = new service_1.ConversationService(client_1.db);
class AIService {
    client;
    rateLimiter;
    constructor() {
        this.client = new sdk_1.default({
            apiKey: config_1.config.anthropicApiKey,
        });
        this.rateLimiter = new rate_limiter_1.RateLimiter({
            maxRequestsPerMinute: config_1.config.claudeRpmLimit,
        });
    }
    async generateResponse(messages, context, userId, correlationId) {
        // Wait for rate limit slot
        await this.rateLimiter.acquire();
        const startTime = Date.now();
        try {
            // Get system prompt based on context (with language adaptation)
            const systemPrompt = await conversationService.getSystemPrompt(context, context.language);
            // Convert messages to Anthropic format
            const anthropicMessages = messages.map((m) => ({
                role: m.role,
                content: m.content,
            }));
            // Call Claude Sonnet 4.5 — excellent quality for structured health conversations at ~5x lower cost than Opus
            const response = await this.client.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 1024,
                system: systemPrompt,
                messages: anthropicMessages,
            });
            const latencyMs = Date.now() - startTime;
            // Extract response content
            const content = response.content
                .filter((block) => block.type === 'text')
                .map((block) => ('text' in block ? block.text : ''))
                .join('\n');
            const usage = {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
            };
            // Log usage for billing
            await (0, logger_1.logAIUsage)({
                userId,
                correlationId,
                model: response.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                latencyMs,
            });
            return {
                content,
                usage,
                model: response.model,
                latencyMs,
            };
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            // Handle rate limiting
            if (err.message.includes('429') || err.message.includes('rate_limit')) {
                throw new errors_1.AIServiceError('Rate limit exceeded, please try again later', err);
            }
            // Handle other API errors
            throw new errors_1.AIServiceError(err.message, err);
        }
    }
    /**
     * Post-process AI response to clean up formatting
     * Basic cleaning only — containment + link are added by the handler
     */
    postProcess(content) {
        let cleaned = content;
        // Convert markdown double asterisks to WhatsApp single asterisks for bold
        cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '*$1*');
        // Keep single *text* (WhatsApp bold) and _text_ (WhatsApp italic) as-is
        // Remove code blocks
        cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
        cleaned = cleaned.replace(/`(.+?)`/g, '$1');
        // Remove markdown headers (keep the text)
        cleaned = cleaned.replace(/^#+\s+/gm, '');
        // Remove excessive newlines
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        // Trim whitespace
        cleaned = cleaned.trim();
        // Limit response length (WhatsApp has a 4096 character limit)
        if (cleaned.length > 4000) {
            cleaned = cleaned.substring(0, 3997) + '...';
        }
        return cleaned;
    }
    /**
     * Split a summary response into acknowledgment + health note parts.
     * Returns null if response doesn't contain a splittable summary.
     */
    splitSummaryResponse(content) {
        const noteIndex = content.indexOf('📋');
        if (noteIndex === -1)
            return null;
        // Look for a transition phrase before 📋 that belongs with the summary
        const beforeNote = content.substring(0, noteIndex);
        const transitionPattern = /\n+((?:here'?s|aquí|voici|aqui|esto es|this is)[^\n]*)\n*$/i;
        let splitIndex = noteIndex;
        const transitionMatch = beforeNote.match(transitionPattern);
        if (transitionMatch && transitionMatch.index !== undefined) {
            splitIndex = transitionMatch.index;
        }
        const acknowledgment = content.substring(0, splitIndex).trim();
        let summary = content.substring(splitIndex).trim();
        // Need meaningful acknowledgment text
        if (!acknowledgment || acknowledgment.length < 10)
            return null;
        // Strip AI-generated containment text from summary (we add our own)
        summary = this.stripContainmentText(summary);
        return { acknowledgment, summary };
    }
    /**
     * Strip AI-generated containment/continuity text to prevent duplication
     */
    stripContainmentText(content) {
        const patterns = [
            /\n+(?:no necesitas recordar|you don'?t need to remember|você não precisa lembrar|vous n'avez pas besoin de tout retenir)[^\n]*/gi,
            /\n+(?:si algo cambia|if anything changes|se algo mudar|si quelque chose change)[^\n]*/gi,
            /\n+(?:tu nota está segura|your note is safe|sua nota está segura|votre note est sûre)[^\n]*/gi,
            /\n+(?:esto está listo|this is ready|está pronto|c'est prêt)[^\n]*/gi,
            /\n+(?:no tienes que cargar|you don'?t have to carry|não precisa carregar)[^\n]*/gi,
            /\n+(?:puedes volver|come back to it|pode voltar|revenez)[^\n]*/gi,
        ];
        let cleaned = content;
        for (const pattern of patterns) {
            cleaned = cleaned.replace(pattern, '');
        }
        return cleaned.replace(/\n{3,}/g, '\n\n').trim();
    }
    /**
     * Build the formatted summary message with containment + link.
     * When concernTitle is provided, prepend a header showing which concern this note belongs to.
     */
    buildSummaryMessage(summary, userId, language, concernTitle) {
        const containment = this.getContainmentText(language);
        const link = this.getSummaryLinkText(language, userId);
        let cleanSummary = summary;
        let header = '';
        if (concernTitle) {
            // Strip AI-generated note header (📋 *Your Health Note* or similar) to prevent
            // duplication with the system-generated header that includes the concern title
            cleanSummary = cleanSummary.replace(/^📋[^\n]*\n+/, '');
            const headerTemplates = {
                es: `📋 *Tu Nota de Salud — ${concernTitle}*`,
                en: `📋 *Your Health Note — ${concernTitle}*`,
                pt: `📋 *Sua Nota de Saúde — ${concernTitle}*`,
                fr: `📋 *Votre Note de Santé — ${concernTitle}*`,
            };
            header = (headerTemplates[language] || headerTemplates.en) + '\n\n';
        }
        return `${header}${cleanSummary}\n\n${containment}\n\n${link}`;
    }
    /**
     * Extract the concern topic from a health note's Concern/Motivo/Queixa field.
     * More reliable than detectConcernTitle for corrections, because it reads
     * what the AI actually wrote rather than guessing from conversation history.
     * Returns a short title (2-5 words) or null if not found.
     */
    extractConcernFromNote(content) {
        // Match the Concern/Motivo/Queixa/Motif field in the note
        const concernMatch = content.match(/\*?(?:Concern|Motivo|Queixa|Motif)\*?:\s*\*?\s*(.+)/i);
        if (!concernMatch || !concernMatch[1])
            return null;
        // Clean up: remove trailing asterisks, markdown, take first sentence
        let raw = concernMatch[1]
            .replace(/\*+/g, '')
            .split(/[.;,–—]/)[0] // Take first phrase before punctuation
            .trim();
        // Shorten to ~5 words for a clean title
        const words = raw.split(/\s+/);
        if (words.length > 5) {
            raw = words.slice(0, 5).join(' ');
        }
        // Capitalize first letter of each word
        const title = raw.split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
        return title.length >= 2 && title.length <= 60 ? title : null;
    }
    /**
     * Check if the response looks like a summary
     */
    looksLikeSummary(content) {
        const summaryIndicators = [
            // Note emoji — strongest single signal
            '📋',
            // Note title variations
            'health note', 'nota de salud', 'nota de saúde', 'note de santé',
            // Field labels (English)
            'concern:', 'started:', 'location:', 'character:', 'severity:', 'pattern:',
            'helps:', 'worsens:', 'medications:',
            // Field labels (Spanish)
            'motivo:', 'inicio:', 'ubicación:', 'carácter:', 'severidad:', 'patrón:',
            'mejora con:', 'empeora con:', 'medicamentos:',
            // Field labels (Portuguese)
            'queixa:', 'início:', 'localização:', 'caráter:', 'gravidade:', 'padrão:',
            'melhora com:', 'piora com:',
            // Field labels (French)
            'motif:', 'début:', 'localisation:', 'caractère:', 'sévérité:', 'schéma:',
            'améliore:', 'aggrave:', 'médicaments:',
            // Legacy/alternate labels
            'resumen', 'summary', 'resumo', 'résumé',
            'onset:', 'preguntas para', 'questions for', 'perguntas para', 'questions pour',
            '---', // Common separator in summaries
        ];
        const lowerContent = content.toLowerCase();
        const matchCount = summaryIndicators.filter(indicator => lowerContent.includes(indicator.toLowerCase())).length;
        // 📋 emoji alone is a strong signal — if present with any 1 field, it's a summary
        // Otherwise need 2+ field indicators
        return matchCount >= 2;
    }
    /**
     * Get containment reinforcement text — emotionally critical
     * Appended after every summary to offload mental burden
     * "You don't need to remember this — it's saved."
     */
    getContainmentText(language) {
        const texts = {
            es: 'No necesitas recordar todo esto — está guardado y organizado. Si algo cambia, solo escríbeme.',
            en: "You don't need to remember all this — it's saved and organized. If anything changes, just tell me.",
            pt: 'Você não precisa lembrar de tudo isso — está salvo e organizado. Se algo mudar, é só me escrever.',
            fr: "Vous n'avez pas besoin de tout retenir — c'est sauvegardé et organisé. Si quelque chose change, dites-le moi.",
        };
        return texts[language] || texts.en;
    }
    /**
     * Get the summary link text in the appropriate language
     * Only shown after summaries, not on every message
     * Reinforces containment: the note is safely saved and accessible
     */
    getSummaryLinkText(language, userId) {
        const link = `https://carelog.vivebien.io/${userId}`;
        const texts = {
            es: `📋 *Tu nota está aquí* 👇\n${link}`,
            en: `📋 *Your note is here* 👇\n${link}`,
            pt: `📋 *Sua nota está aqui* 👇\n${link}`,
            fr: `📋 *Votre note est ici* 👇\n${link}`,
        };
        return texts[language] || texts.en;
    }
    /**
     * Get the name ask message for post-summary delivery
     * Sent as a separate message after the health note to feel natural
     */
    getNameAskMessage(language) {
        const messages = {
            es: 'Por cierto, ¿cómo te gustaría que te llame? Así personalizo tu Nota de Salud. Totalmente opcional.',
            en: "By the way, what's your name? I'll personalize your Health Note. Totally optional.",
            pt: 'A propósito, como gostaria que eu te chamasse? Assim personalizo sua Nota de Saúde. Totalmente opcional.',
            fr: "Au fait, quel nom aimeriez-vous que j'utilise? Je personnaliserai votre Note de Santé. Totalement optionnel.",
        };
        return messages[language] || messages.en;
    }
    /**
     * Generate a simple response without full context (for quick replies)
     */
    async generateQuickResponse(prompt) {
        await this.rateLimiter.acquire();
        try {
            const response = await this.client.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 256,
                messages: [{ role: 'user', content: prompt }],
            });
            const content = response.content
                .filter((block) => block.type === 'text')
                .map((block) => ('text' in block ? block.text : ''))
                .join('\n');
            return this.postProcess(content);
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            throw new errors_1.AIServiceError(err.message, err);
        }
    }
    /**
     * Generate or update a health summary based on conversation history
     * This creates a live summary that can be displayed on a website
     */
    async generateSummary(messages, currentSummary, language, focusTopic, otherTopics) {
        await this.rateLimiter.acquire();
        // Detect language from recent messages or use provided language
        const detectedLang = language || (() => {
            const userText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
            return (0, language_1.detectLanguage)(userText) || 'en';
        })();
        // Language-specific labels for conversation text
        const labels = {
            es: { user: 'Usuario', assistant: 'Asistente' },
            en: { user: 'User', assistant: 'Assistant' },
            pt: { user: 'Usuário', assistant: 'Assistente' },
            fr: { user: 'Utilisateur', assistant: 'Assistant' },
        };
        const label = labels[detectedLang] || labels.en;
        const conversationText = messages
            .map((m) => `${m.role === 'user' ? label.user : label.assistant}: ${m.content}`)
            .join('\n\n');
        const allHeaders = {
            es: {
                mainConcern: 'MOTIVO PRINCIPAL',
                onset: 'INICIO / DURACIÓN',
                pattern: 'PATRÓN / SEVERIDAD',
                factors: 'QUÉ AYUDA / EMPEORA',
                medications: 'MEDICAMENTOS ACTUALES',
                questions: 'PREGUNTAS PARA LA VISITA',
                timeline: 'CRONOLOGÍA',
            },
            en: {
                mainConcern: 'MAIN CONCERN',
                onset: 'ONSET / DURATION',
                pattern: 'PATTERN / SEVERITY',
                factors: 'WHAT HELPS / WORSENS',
                medications: 'CURRENT MEDICATIONS',
                questions: 'QUESTIONS FOR VISIT',
                timeline: 'TIMELINE',
            },
            pt: {
                mainConcern: 'QUEIXA PRINCIPAL',
                onset: 'INÍCIO / DURAÇÃO',
                pattern: 'PADRÃO / GRAVIDADE',
                factors: 'O QUE AJUDA / PIORA',
                medications: 'MEDICAMENTOS ATUAIS',
                questions: 'PERGUNTAS PARA A CONSULTA',
                timeline: 'CRONOLOGIA',
            },
            fr: {
                mainConcern: 'MOTIF PRINCIPAL',
                onset: 'DÉBUT / DURÉE',
                pattern: 'SCHÉMA / GRAVITÉ',
                factors: 'CE QUI AIDE / AGGRAVE',
                medications: 'MÉDICAMENTS ACTUELS',
                questions: 'QUESTIONS POUR LA VISITE',
                timeline: 'CHRONOLOGIE',
            },
        };
        const headers = allHeaders[detectedLang] || allHeaders.en;
        const languageNames = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' };
        const languageName = languageNames[detectedLang] || 'English';
        // Simplified labels for cleaner summaries
        const simpleLabels = {
            es: { concern: 'Motivo', started: 'Inicio', location: 'Ubicación', character: 'Carácter', severity: 'Severidad', pattern: 'Patrón', helps: 'Mejora con', worsens: 'Empeora con', meds: 'Medicamentos' },
            en: { concern: 'Concern', started: 'Started', location: 'Location', character: 'Character', severity: 'Severity', pattern: 'Pattern', helps: 'Helps', worsens: 'Worsens', meds: 'Medications' },
            pt: { concern: 'Queixa', started: 'Início', location: 'Localização', character: 'Caráter', severity: 'Gravidade', pattern: 'Padrão', helps: 'Melhora com', worsens: 'Piora com', meds: 'Medicamentos' },
            fr: { concern: 'Motif', started: 'Début', location: 'Localisation', character: 'Caractère', severity: 'Sévérité', pattern: 'Schéma', helps: 'Améliore', worsens: 'Aggrave', meds: 'Médicaments' },
        };
        const sl = simpleLabels[detectedLang] || simpleLabels.en;
        // Build the exclusion list for focused summaries
        const exclusionNote = (focusTopic && otherTopics && otherTopics.length > 0)
            ? `\n\nEXCLUDE THESE OTHER CONCERNS (do NOT mention them at all):\n${otherTopics.map(t => `- ${t}`).join('\n')}`
            : '';
        const formatTemplate = `${sl.concern}: [what's happening — ONLY about this specific concern]
${sl.started}: [when THIS concern began]
${sl.location}: [where THIS concern is felt]
${sl.character}: [how THIS concern feels — sharp, dull, throbbing, etc.]
${sl.severity}: [how bad THIS concern is, on their scale or 1-10]
${sl.pattern}: [timing, frequency of THIS concern]
${sl.helps}: [what helps THIS concern specifically]
${sl.worsens}: [what worsens THIS concern specifically]
${sl.meds}: [medications relevant to THIS concern]
Family history: [only if relevant to THIS concern]`;
        const baseRules = `Rules:
- Include only fields where information was actually provided (typically 4-7 fields)
- Do NOT include fields where information is unknown — never write "not provided" or "N/A"
- Use the person's exact words and language when possible — this is THEIR record
- Keep each field to 1-2 lines max
- Use simple field labels only (e.g. "${sl.concern}:", "${sl.started}:") — no bold, no markdown, no asterisks
- No bullet points or complex formatting — just "Label: value" on each line
- No medical jargon unless the person used it first
- No patient name or header sections — start directly with the ${sl.concern} field
- Write in ${languageName}`;
        let prompt;
        if (focusTopic) {
            // FOCUSED prompt — single concern extraction with strong isolation
            const sourceData = currentSummary
                ? `CURRENT NOTE FOR "${focusTopic}":\n${currentSummary}\n\nNEW CONVERSATION:\n${conversationText}`
                : `CONVERSATION:\n${conversationText}`;
            prompt = `You are extracting a health note for ONE SPECIFIC concern: "${focusTopic}"
${exclusionNote}

${sourceData}

Extract ONLY information about "${focusTopic}" into this format:

${formatTemplate}

${baseRules}
- CRITICAL ISOLATION RULE: This note is EXCLUSIVELY about "${focusTopic}". Every field must contain ONLY data about "${focusTopic}".
- If the person mentioned other health issues (like a different body part, a different symptom), do NOT include that data in ANY field.
- Example: If this note is about "Stomach Pain" and the person also mentioned a swollen knee, do NOT put knee information in Location, Helps, or any other field.
- ${sl.meds} field: ONLY include medications the person said they take FOR "${focusTopic}" specifically. Do NOT list all medications. Background medications (birth control, metformin, etc.) should ONLY appear if they are relevant to THIS specific concern.
- ${sl.helps} field: ONLY include things that help "${focusTopic}" — not things that help other concerns.
- Family history: Include ONLY if directly relevant to "${focusTopic}" (e.g., family history of gallbladder issues on a stomach pain note).
- When in doubt about whether a piece of information belongs to "${focusTopic}", LEAVE IT OUT.`;
        }
        else if (currentSummary) {
            prompt = `You are CareLog, a calm health documentation companion. Update this health note based on new information.

CURRENT NOTE:
${currentSummary}

NEW INFORMATION:
${conversationText}

Generate a CLEAN, doctor-ready health note. Use this format (include only fields with actual data):

${formatTemplate}

${baseRules}`;
        }
        else {
            prompt = `You are CareLog, a calm health documentation companion. Create a doctor-ready health note from this conversation.

CONVERSATION:
${conversationText}

Generate a CLEAN, doctor-ready health note. Use this format (include only fields with actual data):

${formatTemplate}

${baseRules}`;
        }
        try {
            // Use Sonnet for summaries (cost-effective for structured output)
            const startTime = Date.now();
            const response = await this.client.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }],
            });
            // Log usage for cost tracking
            (0, logger_1.logAIUsage)({
                userId: '',
                correlationId: `summary-${Date.now()}`,
                model: response.model,
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                latencyMs: Date.now() - startTime,
            }).catch(() => { }); // fire-and-forget, don't block summary
            const content = response.content
                .filter((block) => block.type === 'text')
                .map((block) => ('text' in block ? block.text : ''))
                .join('\n');
            return content.trim();
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            // If summary generation fails, log and return current summary or empty
            logger_1.logger.error({ err, currentSummary: !!currentSummary }, 'Failed to generate summary');
            return currentSummary || '';
        }
    }
    /**
     * Detect the main health concern topic from conversation messages.
     * Uses Claude Haiku for fast, lightweight extraction.
     * Returns a short title like "Back pain", "Eye sty", "Headaches"
     */
    async detectConcernTitle(messages, language, existingConcernTitles) {
        await this.rateLimiter.acquire();
        const langName = language === 'es' ? 'Spanish' : language === 'pt' ? 'Portuguese' : language === 'fr' ? 'French' : 'English';
        // Include the FIRST user message as anchor (the initial complaint) + recent messages
        const firstUserMessage = messages.find(m => m.role === 'user');
        const recentMessages = messages.slice(-6);
        let conversationText = '';
        if (firstUserMessage && !recentMessages.includes(firstUserMessage)) {
            conversationText = `User (first message): ${firstUserMessage.content}\n\n...\n\n`;
        }
        conversationText += recentMessages
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n');
        // Build existing concerns context
        const existingContext = existingConcernTitles && existingConcernTitles.length > 0
            ? `\nEXISTING CONCERNS for this user: ${existingConcernTitles.map(t => `"${t}"`).join(', ')}\n- If the conversation is about the SAME condition as an existing concern, return the topic name in ${langName} (translate if existing title is in a different language)\n- Only return a NEW title if the user is clearly discussing a DIFFERENT, UNRELATED health issue\n`
            : '';
        const prompt = `What health topic(s) are being discussed in this conversation? Return the topic name(s) (2-5 words each, in ${langName}).
${existingContext}
RULES:
- PRESERVE the user's own words for conditions they named. If the user says "stye" → "Eye Stye" (NOT "Skin Rash"). If the user says "migraine" → "Migraines" (NOT "Headaches"). If they say "acid reflux" → "Acid Reflux" (NOT "Stomach Pain"). The title MUST be recognizable to the user.
- Use SIMPLE, STABLE names — the kind a patient would use (e.g., "Stomach Pain", "Knee Injury", "Headaches")
- Do NOT use clinical terms. "Headaches" stays "Headaches" — NOT "Migraines With Aura"
- Do NOT return generic names like "Health concern" or "Multiple symptoms" — always be SPECIFIC
- Prefer SPECIFIC over BROAD: "Eye Stye" > "Eye Problem" > "Skin Rash". Use the most specific name the user's description supports.

WHEN TO SPLIT into multiple concerns (one per line):
- Different body parts: stomach pain + knee injury = 2 concerns
- Different systems: digestive issue + dizziness + joint injury = 3 concerns
- Conditions that need separate doctor conversations

WHEN TO KEEP as ONE concern:
- Symptoms of the SAME illness: flu with cough, fever, body aches = "Flu"
- Clearly linked: headache + dizziness that always come together = could be 1 concern
- Sub-symptoms of a named condition: "I have a cold" + runny nose + sore throat = "Cold"

Examples:
- "stomach hurting and knee is swollen and I get dizzy" → THREE concerns:
Stomach Pain
Knee Injury
Dizziness
- "I have the flu with cough and fever" → ONE concern: Flu
- "back pain and also a rash on my arm" → TWO concerns:
Back Pain
Arm Rash
- "I have a stye in my left eye" → ONE concern: Eye Stye
- "headaches and dizziness that come together" → ONE concern: Headaches And Dizziness
- "acid reflux and knee pain" → TWO concerns:
Acid Reflux
Knee Pain

CONVERSATION:
${conversationText}

Topic name(s):`;
        try {
            const startTime = Date.now();
            const response = await this.client.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 100,
                messages: [{ role: 'user', content: prompt }],
            });
            // Log usage for cost tracking
            (0, logger_1.logAIUsage)({
                userId: '',
                correlationId: `concern-${Date.now()}`,
                model: response.model,
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                latencyMs: Date.now() - startTime,
            }).catch(() => { });
            const content = response.content
                .filter(block => block.type === 'text')
                .map(block => ('text' in block ? block.text : ''))
                .join('')
                .trim();
            // Clean up each line (may be multiple titles for unrelated concerns)
            const lines = content.split('\n').map(line => line.trim()).filter(l => l.length > 0);
            const cleanedLines = lines.map(line => {
                let title = line
                    .replace(/^[-•*\d.)\s]+/, '') // Remove list markers
                    .replace(/^["']+|["']+$/g, '') // Remove quotes
                    .replace(/^(the |el |la |le |o )/i, '') // Remove articles
                    .trim();
                // Capitalize first letter of each word
                title = title.split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                    .join(' ');
                return title;
            }).filter(t => t.length >= 2 && t.length <= 60);
            if (cleanedLines.length === 0) {
                return 'Health concern';
            }
            return cleanedLines.join('\n');
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Failed to detect concern title');
            return 'Health concern';
        }
    }
}
exports.AIService = AIService;
//# sourceMappingURL=service.js.map