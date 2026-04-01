"use strict";
/**
 * Plato Inteligente — Smart Ack Messages
 *
 * Generates personalized acknowledgments that MIRROR what the user said.
 * Uses ONE tiny Haiku call (~$0.001) to generate a warm, short ack.
 * Falls back to template acks if the AI call fails.
 * Image-only messages skip AI entirely and use image templates.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSocialMessage = isSocialMessage;
exports.getSocialAck = getSocialAck;
exports.getQuestionAck = getQuestionAck;
exports.isQuestion = isQuestion;
exports.getSmartAck = getSmartAck;
exports.getFallbackAck = getFallbackAck;
exports.getAckMessage = getAckMessage;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const config_1 = require("../config");
const logger_1 = require("../infra/logging/logger");
const client = new sdk_1.default({
    apiKey: config_1.config.anthropicApiKey,
});
// ============================================================================
// Image Ack Templates (no AI needed — just acknowledge the photo)
// ============================================================================
const IMAGE_ACKS = {
    es: [
        'Foto recibida 📸 La analizamos en tu resumen de esta noche.',
        'Imagen guardada 📸 Esta noche la revisamos con detalle.',
        'Recibida tu foto 📸 La incluimos en el análisis de hoy.',
    ],
    en: [
        'Photo received 📸 We\'ll analyze it in your summary tonight.',
        'Image saved 📸 We\'ll review it in detail tonight.',
        'Got your photo 📸 Including it in today\'s analysis.',
    ],
    pt: [
        'Foto recebida 📸 Analisamos no seu resumo de hoje à noite.',
        'Imagem guardada 📸 Revisamos com detalhe hoje à noite.',
    ],
    fr: [
        'Photo reçue 📸 On l\'analyse dans votre résumé ce soir.',
        'Image enregistrée 📸 On la revoit en détail ce soir.',
    ],
};
// ============================================================================
// Fallback Templates (used if Haiku call fails)
// ============================================================================
const FALLBACK_INPUT_ACKS = {
    es: [
        'Listo, lo tengo 👍',
        'Va quedando el registro del día.',
        'Perfecto, queda registrado.',
        'Ahí va 📋',
        'Recibido ✓',
    ],
    en: [
        'Got it 👍',
        'Logged for the day.',
        'Perfect, noted.',
        'Received ✓',
        'All good 📋',
    ],
    pt: [
        'Beleza, anotei 👍',
        'Registrado pro dia.',
        'Recebi ✓',
    ],
    fr: [
        'C\'est noté 👍',
        'Bien reçu.',
        'Enregistré ✓',
    ],
};
const FALLBACK_QUESTION_ACKS = {
    es: [
        'Buena pregunta 👀',
        'Interesante, lo revisamos.',
        'Me la apunto 🤔',
    ],
    en: [
        'Good question 👀',
        'Interesting one, noted.',
        "I'll look into that 🤔",
    ],
    pt: [
        'Boa pergunta 👀',
        'Interessante, anoto aqui.',
    ],
    fr: [
        'Bonne question 👀',
        'Intéressant, je note.',
    ],
};
// ============================================================================
// Social Message Detection + Templates
// Short replies like "yes", "thanks", "ok" — no food log, just a warm reply
// ============================================================================
const SOCIAL_PATTERNS = {
    es: [
        /^(gracias|muchas gracias|ok|okey|okay|sí|si|no|claro|entendido|perfecto|genial|excelente|bien|bueno|de nada|por favor|hola|hasta luego|bye|chao|👍|😊|🙏)$/i,
    ],
    en: [
        /^(thanks|thank you|ok|okay|yes|no|sure|got it|great|perfect|awesome|nice|cool|hi|hello|bye|goodbye|👍|😊|🙏)$/i,
    ],
    pt: [
        /^(obrigado|obrigada|ok|okay|sim|não|nao|claro|entendido|perfeito|ótimo|otimo|bom|oi|tchau|👍|😊|🙏)$/i,
    ],
    fr: [
        /^(merci|ok|okay|oui|non|bien sûr|compris|parfait|super|génial|genial|bonjour|au revoir|👍|😊|🙏)$/i,
    ],
};
const SOCIAL_ACKS = {
    es: ['😊', '👍', '¡Aquí estoy!', 'Cuando quieras.', 'Con gusto.'],
    en: ['😊', '👍', 'Here for you!', 'Anytime.', 'You got it.'],
    pt: ['😊', '👍', 'Aqui estou!', 'Quando quiser.', 'Com prazer.'],
    fr: ['😊', '👍', 'Je suis là!', 'Quand vous voulez.', 'Avec plaisir.'],
};
function isSocialMessage(message) {
    const trimmed = message.trim();
    // Very short messages (1-2 words, no food/health content)
    if (trimmed.length > 30)
        return false;
    const lang = detectMessageLanguage(trimmed);
    const patterns = SOCIAL_PATTERNS[lang] || Object.values(SOCIAL_PATTERNS).flat();
    return patterns.some(p => p.test(trimmed));
}
function detectMessageLanguage(message) {
    const lower = message.toLowerCase();
    if (/gracias|sí|si|hola|claro|bien/.test(lower))
        return 'es';
    if (/thanks|thank|yes|okay|sure|great/.test(lower))
        return 'en';
    if (/obrigad|sim|ótimo|oi/.test(lower))
        return 'pt';
    if (/merci|oui|bien|bonjour/.test(lower))
        return 'fr';
    return 'es';
}
function getSocialAck(language) {
    const lang = language in SOCIAL_ACKS ? language : 'es';
    const pool = SOCIAL_ACKS[lang];
    return pool[Math.floor(Math.random() * pool.length)];
}
// ============================================================================
// Question Ack Templates (NO Haiku — clear expectation setting)
// ============================================================================
const QUESTION_ACK_TEMPLATES = {
    es: [
        'Buena pregunta 👀 Te la respondo esta noche en tu resumen con contexto de tu día.',
        'Me la apunto. Esta noche te doy la respuesta basada en tus datos.',
        'Anotada la pregunta. La incluyo en tu análisis de esta noche.',
    ],
    en: [
        "Good question 👀 I'll answer it tonight in your summary with the context of your day.",
        "Noted. Tonight I'll give you the answer based on your own data.",
        "Question logged. I'll include it in tonight's analysis.",
    ],
    pt: [
        'Boa pergunta 👀 Respondo hoje à noite no seu resumo com contexto do seu dia.',
        'Anotei. Esta noite te dou a resposta baseada nos seus dados.',
    ],
    fr: [
        'Bonne question 👀 Je vous réponds ce soir dans votre résumé avec le contexte de votre journée.',
        'Noté. Ce soir je vous donne la réponse basée sur vos données.',
    ],
};
function getQuestionAck(language) {
    const lang = language in QUESTION_ACK_TEMPLATES ? language : 'es';
    const pool = QUESTION_ACK_TEMPLATES[lang];
    return pool[Math.floor(Math.random() * pool.length)];
}
// ============================================================================
// Question Detection
// ============================================================================
const QUESTION_STARTERS = {
    es: ['qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'cuándo', 'cuando', 'dónde', 'donde', 'cuál', 'cual', 'cuánto', 'cuanto', 'puedo', 'debo', 'es bueno', 'es malo', 'se puede'],
    en: ['what', 'how', 'why', 'when', 'where', 'which', 'can', 'should', 'is it', 'do i', 'does', 'will', 'could', 'would'],
    pt: ['que', 'como', 'por que', 'quando', 'onde', 'qual', 'posso', 'devo'],
    fr: ['que', 'comment', 'pourquoi', 'quand', 'où', 'ou', 'quel', 'quelle', 'est-ce', 'puis-je'],
};
function isQuestion(message) {
    if (message.includes('?'))
        return true;
    const lower = message.toLowerCase().trim();
    for (const starters of Object.values(QUESTION_STARTERS)) {
        for (const starter of starters) {
            if (lower.startsWith(starter + ' ') || lower === starter) {
                return true;
            }
        }
    }
    return false;
}
// ============================================================================
// Smart Ack Generator (Haiku)
// ============================================================================
/**
 * Check if the message is image-only (no real text content from the user).
 */
function isImageOnlyMessage(message) {
    const cleaned = message
        .replace(/\[Image attached\]/gi, '')
        .replace(/\[Image description\]:.*$/gm, '')
        .trim();
    return cleaned.length === 0;
}
/**
 * Get a random image ack template.
 */
function getImageAck(language) {
    const lang = language in IMAGE_ACKS ? language : 'es';
    const pool = IMAGE_ACKS[lang] || IMAGE_ACKS.es;
    return pool[Math.floor(Math.random() * pool.length)];
}
/**
 * Generate a personalized ack that mirrors the user's message.
 * - Social messages ("thanks", "ok", "yes"): warm 1-word reply, no AI
 * - Question messages: template that sets expectation (answer tonight), no AI
 * - Image-only messages: use template, no AI
 * - Food/health text: use Haiku (~$0.001) to mirror what they said
 * - Falls back to templates on any failure
 */
async function getSmartAck(userMessage, language, isQuestionMsg, hasImage = false) {
    const lang = language || 'es';
    // Social messages: short warm reply, no AI, no food logging feel
    if (!hasImage && isSocialMessage(userMessage)) {
        return getSocialAck(lang);
    }
    // Question messages: structured template, no AI
    // Sets clear expectation that the answer comes tonight in the summary
    if (isQuestionMsg && !hasImage) {
        return getQuestionAck(lang);
    }
    // Image-only messages: skip AI, use template
    if (hasImage && isImageOnlyMessage(userMessage)) {
        return getImageAck(lang);
    }
    // Strip image markers from the text before sending to Haiku
    const cleanMessage = userMessage
        .replace(/\[Image attached\]/gi, '')
        .replace(/\[Image description\]:.*$/gm, '')
        .trim();
    // If after cleaning there's no meaningful text, use fallback
    if (!cleanMessage) {
        return hasImage ? getImageAck(lang) : getFallbackAck(lang, isQuestionMsg);
    }
    try {
        const langName = { es: 'Spanish', en: 'English', pt: 'Portuguese', fr: 'French' }[lang] || 'Spanish';
        const imageNote = hasImage ? ' They also sent a photo.' : '';
        const prompt = `You are a warm WhatsApp nutrition companion. The user sent: "${cleanMessage}"${imageNote}

Write a SHORT ack (1 sentence, max 15 words) in ${langName} that:
- Reflects back what they shared using THEIR words
- Feels like a friend texting back, not a system confirmation

RULES:
- NEVER start with "Anotado" — vary your openings every time
- NEVER say "lo incluimos en tu resumen" or "tonight's summary" — just acknowledge warmly
- Use 1 emoji max, and vary which emoji you use
- Match their energy — if they're casual, be casual

Vary your style. Examples of good variety:
- "Huevos con tortilla, clásico 💪"
- "Rica esa combinación de pollo con ensalada."
- "4 vasos de agua, bien ahí 💧"
- "Tacos con aguacate suena increíble 🤤"
- "Eso se escucha pesado, descansa bien."

Reply ONLY with the ack. No quotes.`;
        const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 60,
            messages: [{ role: 'user', content: prompt }],
        });
        const content = response.content[0];
        if (content && content.type === 'text' && content.text.trim()) {
            // Strip any wrapping quotes that Haiku might add
            let ack = content.text.trim();
            if ((ack.startsWith('"') && ack.endsWith('"')) || (ack.startsWith('"') && ack.endsWith('"'))) {
                ack = ack.slice(1, -1);
            }
            return ack;
        }
        return getFallbackAck(lang, isQuestionMsg);
    }
    catch (error) {
        const err = error;
        logger_1.logger.warn({ error: err.message }, 'Smart ack failed, using fallback template');
        return getFallbackAck(lang, isQuestionMsg);
    }
}
/**
 * Pick a random fallback ack (no AI needed).
 */
function getFallbackAck(language, isQuestionMsg) {
    const lang = language in FALLBACK_INPUT_ACKS ? language : 'es';
    const pool = isQuestionMsg
        ? (FALLBACK_QUESTION_ACKS[lang] || FALLBACK_QUESTION_ACKS.es)
        : (FALLBACK_INPUT_ACKS[lang] || FALLBACK_INPUT_ACKS.es);
    return pool[Math.floor(Math.random() * pool.length)];
}
// Keep old function name for backward compatibility
function getAckMessage(language, isQuestionMsg) {
    return getFallbackAck(language, isQuestionMsg);
}
//# sourceMappingURL=ack-messages.js.map