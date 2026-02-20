"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaService = exports.MediaService = void 0;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const openai_1 = __importStar(require("openai"));
const config_1 = require("../../config");
const logger_1 = require("../../infra/logging/logger");
class MediaService {
    anthropic;
    openai;
    constructor() {
        this.anthropic = new sdk_1.default({
            apiKey: config_1.config.anthropicApiKey,
        });
        // OpenAI is required for voice transcription (Whisper)
        this.openai = config_1.config.openaiApiKey
            ? new openai_1.default({ apiKey: config_1.config.openaiApiKey })
            : null;
    }
    async transcribeAudio(audioUrl, language) {
        if (!this.openai) {
            logger_1.logger.warn('OpenAI API key not configured, cannot transcribe audio');
            return '[Voice message received - transcription not available. Please set OPENAI_API_KEY.]';
        }
        try {
            logger_1.logger.info({ audioUrl, language }, 'Starting audio transcription with Whisper');
            const audioResponse = await fetch(audioUrl);
            if (!audioResponse.ok) {
                throw new Error(`Failed to download audio: ${audioResponse.status}`);
            }
            const audioBuffer = await audioResponse.arrayBuffer();
            const buffer = Buffer.from(audioBuffer);
            const contentType = audioResponse.headers.get('content-type') || 'audio/ogg';
            const ext = contentType.includes('mp3') ? 'mp3' : contentType.includes('wav') ? 'wav' : contentType.includes('webm') ? 'webm' : 'ogg';
            // Don't pass language hint - let Whisper auto-detect
            // This ensures English speakers get English transcription even if profile says Spanish
            const transcription = await this.openai.audio.transcriptions.create({
                file: await (0, openai_1.toFile)(buffer, `audio.${ext}`, { type: contentType }),
                model: 'whisper-1',
                response_format: 'text',
            });
            logger_1.logger.info({ transcriptionLength: transcription.length }, 'Audio transcription complete');
            return transcription;
        }
        catch (error) {
            const err = error;
            logger_1.logger.error({ err, audioUrl }, 'Failed to transcribe audio');
            return '[Voice message received - could not transcribe]';
        }
    }
    async analyzeImage(imageUrl, language = 'en', context) {
        try {
            logger_1.logger.info({ imageUrl, language }, 'Starting image analysis');
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
                throw new Error(`Failed to download image: ${imageResponse.status}`);
            }
            const imageBuffer = await imageResponse.arrayBuffer();
            const base64Image = Buffer.from(imageBuffer).toString('base64');
            const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
            const mediaType = contentType.includes('png') ? 'image/png'
                : contentType.includes('gif') ? 'image/gif'
                    : contentType.includes('webp') ? 'image/webp'
                        : 'image/jpeg';
            const prompts = {
                es: 'Analiza esta imagen en el contexto de salud. Describe síntomas, medicamentos o documentos médicos visibles. Sé conciso. Responde en español.',
                en: 'Analyze this image in a health context. Describe any symptoms, medications, or medical documents visible. Be concise. Respond in English.',
                pt: 'Analise esta imagem no contexto de saúde. Descreva sintomas, medicamentos ou documentos médicos visíveis. Seja conciso. Responda em português.',
                fr: 'Analysez cette image dans un contexte de santé. Décrivez les symptômes, médicaments ou documents médicaux visibles. Soyez concis. Répondez en français.',
            };
            const response = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 500,
                system: prompts[language] || prompts.en,
                messages: [{
                        role: 'user',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
                            { type: 'text', text: context || 'Please analyze this image.' },
                        ],
                    }],
            });
            const content = response.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
            logger_1.logger.info({ responseLength: content.length }, 'Image analysis complete');
            return content;
        }
        catch (error) {
            const err = error;
            logger_1.logger.error({ err, imageUrl }, 'Failed to analyze image');
            return '[Image received - could not analyze]';
        }
    }
}
exports.MediaService = MediaService;
exports.mediaService = new MediaService();
//# sourceMappingURL=service.js.map