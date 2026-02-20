/**
 * Plato Inteligente — Branded PDF Generator
 *
 * Generates pixel-perfect branded PDFs from nightly summary data.
 * Uses Puppeteer (headless Chromium) to render HTML → PDF.
 *
 * The HTML template matches the Figma design:
 * - 402px wide, single continuous page
 * - Lora (headings) + Roboto (body) fonts via Google Fonts
 * - Branded color sections: yellow, orange, green
 * - Logo + search icon embedded as base64
 */
declare function renderHtml(rawData: Record<string, unknown>): string;
export declare function generateSummaryPdf(summaryData: Record<string, unknown>): Promise<Buffer>;
export { renderHtml };
//# sourceMappingURL=generator.d.ts.map