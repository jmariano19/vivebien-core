export interface VoiceSynthesisResult {
    audioBuffer: Buffer;
    contentType: string;
    durationEstimate: number;
}
export declare class VoiceService {
    private apiKey;
    private defaultVoiceId;
    constructor();
    /**
     * Check if voice synthesis is available
     */
    isAvailable(): boolean;
    /**
     * Synthesize text to speech using ElevenLabs API.
     * Returns the audio buffer (MP3 format).
     */
    synthesizeSpeech(text: string, voiceId?: string, language?: string): Promise<VoiceSynthesisResult | null>;
    /**
     * Generate a warm, personal digest script from pattern summary.
     * This creates the text that will be spoken by the voice.
     */
    generateDigestScript(patterns: string[], mealCount: number, language: string, userName?: string): string;
}
//# sourceMappingURL=service.d.ts.map