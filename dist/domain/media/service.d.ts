export declare class MediaService {
    private anthropic;
    private openai;
    constructor();
    transcribeAudio(audioUrl: string, language?: string): Promise<string>;
    analyzeImage(imageUrl: string, language?: string, context?: string): Promise<string>;
}
export declare const mediaService: MediaService;
//# sourceMappingURL=service.d.ts.map