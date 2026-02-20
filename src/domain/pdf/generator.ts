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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../infra/logging/logger';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

interface MealData {
  time: string;
  title: string;
  name?: string;
  bullets: string[];
  insights?: string[];
}

interface SignalItem {
  direction: 'up' | 'down';
  bold?: string;
  label?: string;
  text: string;
}

interface QuestionData {
  question: string;
  answer: string;
}

interface ExtraSection {
  heading: string;
  content: string;
}

interface SummaryData {
  // Header
  greeting_name?: string;
  name?: string;
  day_number?: number;
  date?: string;

  // Title
  title_line1?: string;
  title_line2?: string;

  // Meals
  meals?: MealData[];

  // Signal
  signal_intro?: string;
  signal_items?: SignalItem[];
  signal_explanation?: string;

  // Sections
  willpower_text?: string;
  advantage_text?: string;
  pattern_text?: string;

  // Questions
  questions?: QuestionData[];

  // Extra sections
  extra_sections?: ExtraSection[];

  // Experiment
  experiment_heading?: string;
  experiment_steps?: string[];
  observe_text?: string;

  // Footer
  footer_quote_1?: string;
  footer_quote_2?: string;
}

// ──────────────────────────────────────────────
// ASSET LOADING
// ──────────────────────────────────────────────

function loadBase64Asset(filename: string): string {
  // Check multiple locations for assets
  const locations = [
    path.join(process.cwd(), 'plato-summary', 'assets', filename),
    path.join('/app', 'plato-summary', 'assets', filename),
    path.join(__dirname, '..', '..', '..', 'plato-summary', 'assets', filename),
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      return fs.readFileSync(loc).toString('base64');
    }
  }

  logger.warn({ filename }, 'Asset not found, PDF will render without it');
  return '';
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function autoBoldBullet(text: string): string {
  if (!text.includes(' — ') && !text.includes(' —')) return text;

  const dashPos = text.includes(' — ')
    ? text.indexOf(' — ')
    : text.indexOf(' —');

  const prefix = text.substring(0, dashPos);
  if (prefix.includes('<b>') && prefix.includes('</b>')) return text;

  let cleanPrefix = prefix.replace(/<b>/g, '').replace(/<\/b>/g, '').trim();
  const rest = text.substring(dashPos);

  let leadQuote = '';
  if (cleanPrefix && (cleanPrefix[0] === '"' || cleanPrefix[0] === '\u201c' || cleanPrefix[0] === '\u2018')) {
    leadQuote = cleanPrefix[0]!;
    cleanPrefix = cleanPrefix.substring(1).trim();
  }

  return `${leadQuote}<b>${cleanPrefix}</b>${rest}`;
}

function escapeHtml(text: string): string {
  // Don't escape HTML tags that are intentional (<b>, <i>, etc.)
  return text;
}

// ──────────────────────────────────────────────
// MAP HAIKU OUTPUT → PDF DATA
// ──────────────────────────────────────────────

function mapToPdfData(raw: Record<string, unknown>): SummaryData {
  const data = raw as SummaryData;

  // Normalize meals
  const meals = (data.meals || []).map((m: MealData) => ({
    time: m.time || '',
    title: m.title || m.name || '',
    bullets: m.bullets || m.insights || [],
  }));

  // Normalize signal items
  const signalItems = (data.signal_items || []).map((item: SignalItem) => ({
    direction: item.direction || 'up',
    bold: item.bold || item.label || '',
    text: item.text || '',
  }));

  return {
    ...data,
    name: data.greeting_name || data.name || '',
    meals,
    signal_items: signalItems,
  };
}

// ──────────────────────────────────────────────
// HTML TEMPLATE
// ──────────────────────────────────────────────

function renderHtml(rawData: Record<string, unknown>): string {
  const data = mapToPdfData(rawData);

  const name = data.name || '';
  const day = data.day_number || 1;
  const date = data.date || '';
  const title1 = data.title_line1 || `${name}, tu día tiene un patrón.`;
  const title2 = data.title_line2 || 'Hoy lo hicimos visible.';

  const logoB64 = loadBase64Asset('logo.png');
  const searchB64 = loadBase64Asset('search.png');
  const logoSrc = logoB64 ? `data:image/png;base64,${logoB64}` : '';
  const searchSrc = searchB64 ? `data:image/png;base64,${searchB64}` : '';

  // Build meals HTML
  let mealsHtml = '';
  for (const meal of (data.meals || [])) {
    mealsHtml += `<p class="meal-title"><b>${meal.time} — ${meal.title}</b></p>\n`;
    mealsHtml += '<ul class="meal-bullets">\n';
    for (const bullet of (meal.bullets || [])) {
      mealsHtml += `  <li>${autoBoldBullet(bullet)}</li>\n`;
    }
    mealsHtml += '</ul>\n';
  }

  // Build signal items HTML
  let signalItemsHtml = '';
  for (const item of (data.signal_items || [])) {
    if (item.direction === 'up') {
      signalItemsHtml += `<li><span class="signal-up">↑ ${item.bold}</span> ${item.text}</li>\n`;
    } else {
      signalItemsHtml += `<li><span class="signal-down">↓ ${item.bold}</span> ${item.text}</li>\n`;
    }
  }

  // Build advantage paragraphs
  let advantageHtml = '';
  if (data.advantage_text) {
    for (const para of data.advantage_text.split('\n')) {
      const p = para.trim();
      if (p) advantageHtml += `<p>${p}</p>\n`;
    }
  }

  // Build extra sections (including questions)
  const extraSections = [...(data.extra_sections || [])];

  // Add questions as an extra section if present
  if (data.questions && data.questions.length > 0) {
    let qContent = '';
    for (const q of data.questions) {
      qContent += `<b>Tu preguntaste: "${q.question}"</b>\n${q.answer}\n\n`;
    }
    extraSections.push({
      heading: 'TUS PREGUNTAS',
      content: qContent.trim(),
    });
  }

  let extrasHtml = '';
  for (const extra of extraSections) {
    let heading = extra.heading;
    const hasCheck = heading.startsWith('✅');
    if (hasCheck) heading = heading.replace('✅ ', '').replace('✅', '');

    const checkHtml = hasCheck
      ? '<span class="checkmark"><svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="10" fill="#007E3D"/><polyline points="5.5,10 8.5,13 14.5,7" stroke="white" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span> '
      : '';

    let contentHtml = '';
    for (const para of extra.content.split('\n')) {
      const p = para.trim();
      if (!p) {
        contentHtml += '<div class="spacer-sm"></div>\n';
      } else if (p.startsWith('• ') || p.startsWith('- ') || p.startsWith('· ')) {
        const clean = p.replace(/^[•·\-]\s*/, '');
        contentHtml += `<ul class="meal-bullets"><li>${clean}</li></ul>\n`;
      } else {
        contentHtml += `<p>${p}</p>\n`;
      }
    }

    const dotHtml = hasCheck ? '' : '<div class="section-dot"></div>';
    extrasHtml += `
        <section class="section bg-yellow">
            ${dotHtml}
            <h2 class="section-heading">${checkHtml}${heading}</h2>
            <div class="section-body">${contentHtml}</div>
        </section>\n`;
  }

  // Build pattern HTML
  let patternHtml = '';
  if (data.pattern_text) {
    for (const para of data.pattern_text.split('\n')) {
      const p = para.trim();
      if (p) patternHtml += `<p>${p}</p>\n`;
    }
  }

  // Build experiment steps
  let experimentHtml = '';
  for (let i = 0; i < (data.experiment_steps || []).length; i++) {
    const step = data.experiment_steps![i];
    experimentHtml += `
            <div class="exp-step">
                <div class="exp-circle">${i + 1}</div>
                <div class="exp-text">${step}</div>
            </div>\n`;
  }

  const expHeading = data.experiment_heading || 'EXPERIMENTO PARA MAÑANA';
  const observeText = data.observe_text || '';
  const q1 = data.footer_quote_1 || 'No estás haciendo dieta.';
  const q2 = data.footer_quote_2 || 'Estás aprendiendo a leer tu biología.';
  const signalIntro = data.signal_intro || '';
  const signalExplanation = data.signal_explanation || '';
  const willpowerText = data.willpower_text || '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=402">
<title>Resumen — ${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&family=Roboto:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #F9F6F0;
    display: flex;
    justify-content: center;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    width: 402px;
    background: #F9F6F0;
    font-family: 'Roboto', sans-serif;
    font-size: 16px;
    line-height: 1.4;
    color: #000;
    position: relative;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: flex-start;
    padding: 22px 20px 20px 20px;
    min-height: 156px;
    position: relative;
  }
  .day-badge {
    background: #E8B054;
    border-radius: 5px;
    width: 105px;
    height: 71px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin-left: 19px;
    flex-shrink: 0;
  }
  .day-badge .day-num {
    font-family: 'Roboto', sans-serif;
    font-weight: 700;
    font-size: 34px;
    line-height: 1;
    color: #000;
  }
  .day-badge .day-date {
    font-family: 'Roboto', sans-serif;
    font-weight: 400;
    font-size: 9px;
    color: #000;
    margin-top: 4px;
  }
  .header-divider {
    width: 1px;
    background: #C0C0C0;
    align-self: stretch;
    margin: 0 16px;
    min-height: 134px;
  }
  .header-brand {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding-top: 0;
  }
  .header-logo {
    width: 73px;
    height: 71px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .header-brand-text { padding-top: 4px; }
  .brand-name {
    font-family: 'Roboto', sans-serif;
    font-weight: 700;
    font-size: 19px;
    line-height: 1.15;
    color: #000;
  }
  .header-tagline {
    font-family: 'Roboto', sans-serif;
    font-weight: 400;
    font-size: 12px;
    line-height: 1.3;
    color: #000;
    margin-top: 12px;
    max-width: 153px;
  }
  .title-block {
    text-align: center;
    padding: 16px 20px 24px;
  }
  .title-block h1 {
    font-family: 'Lora', serif;
    font-weight: 700;
    font-size: 22px;
    line-height: 1.3;
    color: #000;
  }
  section.section {
    position: relative;
    padding: 24px 28px;
  }
  .section-dot {
    position: absolute;
    left: 14px;
    top: 31px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #8B9A3A;
  }
  .section-heading {
    font-family: 'Lora', serif;
    font-weight: 700;
    font-size: 19px;
    line-height: 1.3;
    color: #000;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-heading .checkmark {
    display: inline-flex;
    flex-shrink: 0;
  }
  .section-body {
    font-family: 'Roboto', sans-serif;
    font-size: 16px;
    line-height: 1.4;
  }
  .section-body p { margin-bottom: 8px; }
  .section-body p:last-child { margin-bottom: 0; }
  .bg-yellow { background: #FFFADF; }
  .bg-orange { background: #FFEBB8; }
  .bg-green-lt { background: #ECFFB8; }
  .signal-section {
    position: relative;
    background: #FFEBB8;
    padding: 24px 28px;
  }
  .signal-section .section-dot {
    position: absolute;
    left: 14px;
    top: 31px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #8B9A3A;
  }
  .signal-list {
    list-style: disc;
    padding-left: 22px;
    margin: 8px 0;
  }
  .signal-list li {
    margin-bottom: 6px;
    line-height: 1.5;
  }
  .signal-up { color: #007E3D; font-weight: 700; }
  .signal-down { color: #FF0004; font-weight: 700; }
  .meal-title { font-weight: 700; margin-bottom: 8px; }
  .meal-bullets {
    list-style: disc;
    padding-left: 22px;
    margin-bottom: 16px;
  }
  .meal-bullets li { margin-bottom: 6px; line-height: 1.4; }
  .experiment-section {
    background: #ECFFB8;
    position: relative;
    padding: 24px 28px;
  }
  .experiment-section .section-dot {
    position: absolute;
    left: 14px;
    top: 31px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #8B9A3A;
  }
  .exp-step {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 20px;
  }
  .exp-circle {
    width: 45px;
    height: 45px;
    min-width: 45px;
    border-radius: 50%;
    background: #5E8502;
    color: white;
    font-family: 'Lora', serif;
    font-weight: 700;
    font-size: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .exp-text { font-size: 16px; line-height: 1.4; padding-top: 8px; }
  .observe-banner {
    background: #5E8502;
    display: flex;
    align-items: center;
    padding: 22px 28px;
    gap: 14px;
    min-height: 115px;
  }
  .observe-icon { width: 57px; height: 57px; object-fit: contain; flex-shrink: 0; }
  .observe-text { color: white; font-size: 16px; line-height: 1.4; }
  .footer {
    background: #F9F6F0;
    text-align: center;
    padding: 28px 28px 32px;
  }
  .footer-quote { margin-bottom: 4px; }
  .footer-quote .q1 { font-weight: 700; font-size: 16px; }
  .footer-quote .q2 { font-size: 16px; }
  .footer-review { font-size: 16px; margin-top: 16px; margin-bottom: 24px; }
  .footer-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-bottom: 24px;
  }
  .footer-logo { width: 73px; height: 71px; object-fit: cover; }
  .footer-brand-name {
    font-family: 'Roboto', sans-serif;
    font-weight: 700;
    font-size: 19px;
    line-height: 1.15;
    text-align: left;
  }
  .footer-disclaimer { font-size: 15px; color: #000; }
  .spacer-sm { height: 8px; }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="day-badge">
      <span class="day-num">Día ${day}</span>
      <span class="day-date">${date}</span>
    </div>
    <div class="header-divider"></div>
    <div class="header-brand">
      ${logoSrc ? `<img class="header-logo" src="${logoSrc}" alt="Logo">` : ''}
      <div class="header-brand-text">
        <div class="brand-name">Tu Plato<br>Inteligente</div>
        <div class="header-tagline">La comida y tu estilo de vida son medicina — con verdad y entendimiento.</div>
      </div>
    </div>
  </div>

  <div class="title-block">
    <h1>${title1}<br>${title2}</h1>
  </div>

  <section class="section bg-yellow">
    <div class="section-dot"></div>
    <h2 class="section-heading">TU PLATO HOY</h2>
    <div class="section-body">
      ${mealsHtml}
    </div>
  </section>

  <div class="signal-section">
    <div class="section-dot"></div>
    <h2 class="section-heading">SEÑAL PRINCIPAL DE HOY</h2>
    <div class="section-body">
      <p>\u201c${signalIntro}\u201d</p>
      <ul class="signal-list">
        ${signalItemsHtml}
      </ul>
      <p>\u201c${signalExplanation}\u201d</p>
    </div>
  </div>

  <section class="section bg-green-lt">
    <div class="section-dot"></div>
    <h2 class="section-heading">ESTO NO ES FUERZA DE VOLUNTAD</h2>
    <div class="section-body">
      <p>\u201c${willpowerText}\u201d</p>
    </div>
  </section>

  <section class="section bg-yellow">
    <div class="section-dot"></div>
    <h2 class="section-heading">TU VENTAJA METABÓLICA</h2>
    <div class="section-body">
      ${advantageHtml}
    </div>
  </section>

  ${extrasHtml}

  <section class="section bg-yellow">
    <div class="section-dot"></div>
    <h2 class="section-heading">PATRÓN EMERGENTE</h2>
    <div class="section-body">
      ${patternHtml}
    </div>
  </section>

  <div class="experiment-section">
    <div class="section-dot"></div>
    <h2 class="section-heading">${expHeading}</h2>
    ${experimentHtml}
  </div>

  <div class="observe-banner">
    ${searchSrc ? `<img class="observe-icon" src="${searchSrc}" alt="Observa">` : ''}
    <div class="observe-text">${observeText}</div>
  </div>

  <div class="footer">
    <div class="footer-quote">
      <div class="q1">${q1}</div>
      <div class="q2">${q2}</div>
    </div>
    <div class="footer-review">Revisión: <b>Dra. Hernández</b></div>
    <div class="footer-brand">
      ${logoSrc ? `<img class="footer-logo" src="${logoSrc}" alt="Logo">` : ''}
      <div class="footer-brand-name">Tu Plato<br>Inteligente</div>
    </div>
    <div class="footer-disclaimer">Esto no sustituye a tu médico</div>
  </div>

</div>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// PDF GENERATION
// ──────────────────────────────────────────────

export async function generateSummaryPdf(summaryData: Record<string, unknown>): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const htmlPath = path.join(tmpDir, `plato-summary-${Date.now()}.html`);

  try {
    // Step 1: Render HTML
    const html = renderHtml(summaryData);
    fs.writeFileSync(htmlPath, html, 'utf-8');

    // Step 2: Convert to PDF via Puppeteer
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 402, height: 800 });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait extra time for Google Fonts to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Measure actual page height (runs in browser context via Puppeteer)
    // @ts-ignore — document exists in browser context inside page.evaluate
    const pageHeight: number = await page.evaluate('document.querySelector(".page")?.scrollHeight || 800');

    // Generate single-page PDF
    const pdfBuffer = await page.pdf({
      width: '402px',
      height: `${pageHeight}px`,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      printBackground: true,
      preferCSSPageSize: false,
    });

    await browser.close();

    logger.info({ size: pdfBuffer.length, pageHeight }, 'PDF generated successfully');
    return Buffer.from(pdfBuffer);
  } finally {
    // Cleanup
    try { fs.unlinkSync(htmlPath); } catch { /* ignore */ }
  }
}

// Export renderHtml for testing
export { renderHtml };
