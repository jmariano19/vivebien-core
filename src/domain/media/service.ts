import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../infra/logging/logger';

export class MediaService {
  private anthropic: Anthropic;
  private openai: OpenAI | null;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
    });

    // OpenAI is required for voice transcription (Whisper)
    this.openai = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey })
      : null;
  }

  async transcribeAudio(audioUrl: string, language?: string): Promise<string> {
    if (!this.openai) {
      logger.warn('OpenAI API key not configured, cannot transcribe audio');
      return '[Voice message received - transcription not available. Please set OPENAI_API_KEY.]';
    }

    try {
      logger.info({ audioUrl, language }, 'Starting audio transcription with Whisper');

      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        throw new Error(`Failed to download audio: ${audioResponse.status}`);
      }

      const audioBuffer = await audioResponse.arrayBuffer();
      const audioFile = new File([audioBuffer], 'audio.ogg', {
        type: audioResponse.headers.get('content-type') || 'audio/ogg'
      });

      const transcription = await this.openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: language === 'es' ? 'es' : language === 'pt' ? 'pt' : language === 'fr' ? 'fr' : undefined,
        response_format: 'text',
      });

      logger.info({ transcriptionLength: transcription.length }, 'Audio transcription complete');
      return transcription;
    } catch (error) {
      const err = error as Error;
      logger.error({ err, audioUrl }, 'Failed to transcribe audio');
      return '[Voice message received - could not transcribe]';
    }
  }

  async analyzeImage(imageUrl: string, language: string = 'en', context?: string): Promise<string> {
    try {
      logger.info({ imageUrl, language }, 'Starting image analysis');

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

      const prompts: Record<string, string> = {
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
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: base64Image } },
            { type: 'text', text: context || 'Please analyze this image.' },
          ],
        }],
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n');

      logger.info({ responseLength: content.length }, 'Image analysis complete');
      return content;
    } catch (error) {
      const err = error as Error;
      logger.error({ err, imageUrl }, 'Failed to analyze image');
      return '[Image received - could not analyze]';
    }
  }
}

export const mediaService = new MediaService();
