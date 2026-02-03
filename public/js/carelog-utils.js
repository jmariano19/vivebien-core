/**
 * CareLog Shared Utilities
 * Consolidates parsing, formatting, and cleanup functions used across pages
 *
 * Include in HTML: <script src="/js/carelog-utils.js"></script>
 */

// =============================================================================
// PARSING PATTERNS - Single source of truth
// =============================================================================

const CARELOG = {
  // Update page format patterns (Main concern: X)
  UPDATE_PATTERNS: {
    mainConcern: /^Main concern:\s*(.+)/im,
    started: /^Started:\s*(.+)/im,
    location: /^Location:\s*(.+)/im,
    symptoms: /^Symptoms:\s*(.+)/im,
    whatHelps: /^What helps:\s*(.+)/im,
    whatWorsens: /^What worsens:\s*(.+)/im,
    medications: /^Medications:\s*(.+)/im,
    notes: /^Notes:\s*(.+)/im
  },

  // Simplified format patterns (Motivo: X)
  SIMPLE_PATTERNS: {
    mainConcern: /^(?:Motivo|Concern|Queixa|Motif):\s*(.+)/im,
    started: /^(?:Inicio|Started|Início|Début):\s*(.+)/im,
    whatHelps: /^(?:Mejora con|Helps|Melhora com|Améliore):\s*(.+)/im,
    whatWorsens: /^(?:Empeora con|Worsens|Piora com|Aggrave):\s*(.+)/im,
    medications: /^(?:Medicamentos|Medications|Médicaments):\s*(.+)/im
  },

  // AI-generated format patterns (MOTIVO PRINCIPAL)
  AI_PATTERNS: {
    mainConcern: [
      /(?:MOTIVO PRINCIPAL|MAIN CONCERN|QUEIXA PRINCIPAL|MOTIF PRINCIPAL)[:\s]*\n?([^\n]+)/i,
      /(?:Motivo de consulta|Chief complaint)[:\s]*([^\n]+)/i,
    ],
    started: [
      /(?:INICIO|ONSET|INÍCIO|DÉBUT)[^:]*[:\s]*\n?([^\n]+)/i,
      /(?:DURACIÓN|DURATION|DURAÇÃO)[:\s]*([^\n]+)/i,
      /(?:Started|Comenzó|Início)[:\s]*([^\n]+)/i,
    ],
    location: [
      /(?:LOCALIZACIÓN|LOCATION|LOCALIZAÇÃO)[:\s]*\n?([^\n]+)/i,
    ],
    whatHelps: [
      /(?:QUÉ AYUDA|WHAT HELPS|O QUE AJUDA)[^:]*[:\s]*\n?([^\n]+)/i,
      /[-•]\s*Helps?:\s*([^\n]+)/i,
      /Factores que alivian[:\s]*([^\n]+)/i,
    ],
    whatWorsens: [
      /(?:EMPEORA|WORSENS|PIORA|AGGRAVE)[^:]*[:\s]*\n?([^\n]+)/i,
      /[-•]\s*Worsens?:\s*([^\n]+)/i,
      /Factores que agravan[:\s]*([^\n]+)/i,
    ],
    medications: [
      /(?:MEDICAMENTOS|MEDICATIONS|MÉDICAMENTS)[^:]*[:\s]*\n?([^\n]+)/i,
    ]
  },

  // Headers to strip for display cleaning
  HEADERS_TO_CLEAN: [
    'MOTIVO PRINCIPAL', 'MAIN CONCERN', 'QUEIXA PRINCIPAL', 'MOTIF PRINCIPAL',
    'INICIO', 'ONSET', 'INÍCIO', 'DÉBUT', 'DURACIÓN', 'DURATION',
    'LOCALIZACIÓN', 'LOCATION', 'LOCALIZAÇÃO',
    'QUÉ AYUDA', 'WHAT HELPS', 'O QUE AJUDA',
    'EMPEORA', 'WORSENS', 'PIORA', 'AGGRAVE',
    'MEDICAMENTOS', 'MEDICATIONS', 'MÉDICAMENTS',
    'SÍNTOMAS', 'SYMPTOMS', 'SINTOMAS',
    'PATRÓN', 'PATTERN', 'SEVERIDAD', 'SEVERITY',
    'FACTORES', 'FACTORS', 'CARACTERÍSTICAS', 'CHARACTERISTICS',
    'Health Summary', 'Resumen de Salud', 'Health Record', 'Registro de Salud',
    'Questions for your visit', 'Preguntas para tu visita',
    'Main concern', 'Started', 'Location', 'Symptoms', 'What helps',
    'What worsens', 'Medications', 'Notes',
    'Motivo', 'Inicio', 'Mejora con', 'Empeora con'
  ],

  // Invalid/placeholder patterns to filter out
  INVALID_PATTERNS: [
    /^no\s*proporcionado$/i,
    /^not\s*provided$/i,
    /^n\/a$/i,
    /^none$/i,
    /^ninguno$/i,
    /^no\s*aplica$/i,
    /^usuario\s*reporta/i,
    /^patient\s*reports?/i,
    /^-+$/,
    /^\.+$/,
    /^[\s\-•*./,]+$/
  ]
};

// =============================================================================
// PARSING FUNCTIONS
// =============================================================================

/**
 * Parse a health summary text into structured fields
 * Works with all formats: Update page, Simple, and AI-generated
 */
function parseHealthSummary(text) {
  const fields = {
    mainConcern: '',
    started: '',
    location: '',
    symptoms: '',
    whatHelps: '',
    whatWorsens: '',
    medications: '',
    notes: ''
  };

  if (!text) return fields;

  // Normalize text first
  let cleaned = normalizeText(text);

  // Try Simple format first (Motivo: X)
  for (const [key, pattern] of Object.entries(CARELOG.SIMPLE_PATTERNS)) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      fields[key] = cleanFieldValue(match[1]);
    }
  }

  // Try Update page format (Main concern: X)
  for (const [key, pattern] of Object.entries(CARELOG.UPDATE_PATTERNS)) {
    if (fields[key]) continue; // Skip if already found
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      fields[key] = cleanFieldValue(match[1]);
    }
  }

  // Fallback to AI patterns if main concern not found
  if (!fields.mainConcern) {
    for (const [key, patterns] of Object.entries(CARELOG.AI_PATTERNS)) {
      if (fields[key]) continue;
      for (const pattern of patterns) {
        const match = cleaned.match(pattern);
        if (match && match[1]) {
          fields[key] = cleanFieldValue(match[1]);
          break;
        }
      }
    }
  }

  // Handle corruption: extract embedded 'Helps:' from whatWorsens
  if (fields.whatWorsens && fields.whatWorsens.includes('Helps:')) {
    const embeddedHelps = fields.whatWorsens.match(/Helps?:\s*([^,.\n]+)/i);
    if (embeddedHelps && !fields.whatHelps) {
      fields.whatHelps = cleanFieldValue(embeddedHelps[1]);
    }
    fields.whatWorsens = cleanFieldValue(
      fields.whatWorsens.replace(/[-•]?\s*Helps?:\s*[^,.\n]+/gi, '')
    );
  }

  // Extract timing if not found
  if (!fields.started) {
    const timingMatch = cleaned.match(/(\d+\s*(?:days?|hours?|weeks?|días?|horas?|semanas?)\s*(?:ago)?)/i);
    if (timingMatch) {
      fields.started = timingMatch[1].trim();
    }
  }

  // Validate all fields
  for (const key of Object.keys(fields)) {
    if (!isValidFieldValue(fields[key])) {
      fields[key] = '';
    }
  }

  return fields;
}

/**
 * Normalize text by removing markdown and emojis
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // **bold** -> bold
    .replace(/\*([^*]+)\*/g, '$1')       // *italic* -> italic
    .replace(/📝|❓|•/g, '')              // emojis/bullets
    .replace(/---+/g, '\n')              // dividers
    .replace(/^#+\s*/gm, '');            // # headers
}

/**
 * Clean a field value by removing labels, prefixes, and garbage
 */
function cleanFieldValue(value) {
  if (!value) return '';

  let cleaned = value
    // Remove repeated label patterns (corruption from multiple saves)
    .replace(/(What worsens:\s*)+/gi, '')
    .replace(/(What helps:\s*)+/gi, '')
    .replace(/(Medications:\s*)+/gi, '')
    .replace(/(Started:\s*)+/gi, '')
    .replace(/(Location:\s*)+/gi, '')
    .replace(/(Symptoms:\s*)+/gi, '')
    .replace(/(Main concern:\s*)+/gi, '')
    // Remove embedded labels
    .replace(/- Helps?:\s*/gi, '')
    .replace(/• Helps?:\s*/gi, '')
    .replace(/- Worsens?:\s*/gi, '')
    .replace(/• Worsens?:\s*/gi, '')
    .replace(/Helps?:\s*/gi, '')
    .replace(/Worsens?:\s*/gi, '')
    // Remove standalone labels
    .replace(/^\s*\/?\s*WORSENS\s*/gi, '')
    .replace(/^\s*\/?\s*HELPS\s*/gi, '')
    // Standard cleanup
    .replace(/^[\-•*\s\/]+/, '')
    .replace(/[\-•*\s\/]+$/, '')
    // Remove AI text prefixes
    .replace(/Patient reports (having )?/gi, '')
    .replace(/\bpatient\b/gi, '')
    .replace(/\breports\b/gi, '')
    .replace(/usuario\s*reporta\s*["']?/gi, '')
    .replace(/["']\s*$/g, '')
    // Clean placeholders
    .replace(/^no\s*proporcionado$/i, '')
    .replace(/^not\s*provided$/i, '')
    .replace(/^n\/a$/i, '')
    .replace(/^none$/i, '')
    .replace(/^ninguno$/i, '')
    // Other cleanup
    .replace(/\bapproximately\b/gi, 'about')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

/**
 * Check if a field value is valid (not empty or placeholder)
 */
function isValidFieldValue(value) {
  if (!value || value.length < 2) return false;
  return !CARELOG.INVALID_PATTERNS.some(p => p.test(value.trim()));
}

// =============================================================================
// DISPLAY FUNCTIONS
// =============================================================================

/**
 * Clean summary text for display (remove all headers and formatting)
 */
function cleanForDisplay(text) {
  if (!text) return '';

  // Build single regex for all headers (more efficient than loop)
  const headerRegex = new RegExp(
    CARELOG.HEADERS_TO_CLEAN.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + '[:\\s]*',
    'gi'
  );

  let cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/---+/g, ' ')
    .replace(/📝|❓|•/g, '')
    .replace(headerRegex, '')
    .replace(/no\s*proporcionado/gi, '')
    .replace(/not\s*provided/gi, '')
    .replace(/usuario\s*reporta\s*["']?/gi, '')
    .replace(/patient\s*reports?\s*/gi, '')
    .replace(/["']\s*$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[-–—]\s*/gm, '')
    .replace(/\s*[-–—]\s*$/gm, '')
    .replace(/\.\s*\./g, '.')
    .replace(/,\s*,/g, ',')
    .trim();

  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }

  return cleaned || 'Health information recorded';
}

/**
 * Build a natural language summary from parsed fields
 */
function buildNaturalSummary(fields, options = {}) {
  const parts = [];

  if (isValidFieldValue(fields.mainConcern)) {
    let concern = cleanFieldValue(fields.mainConcern);
    concern = concern.charAt(0).toUpperCase() + concern.slice(1);
    parts.push(concern);
  }

  if (isValidFieldValue(fields.started)) {
    let started = cleanFieldValue(fields.started);
    if (/\d|days?|hours?|weeks?|días?|horas?|semanas?|ago|hace|há/i.test(started)) {
      if (!/^(hace|há|about|\d)/i.test(started)) {
        parts.push(`Started ${started.toLowerCase()}`);
      } else {
        parts.push(started.charAt(0).toUpperCase() + started.slice(1));
      }
    }
  }

  if (isValidFieldValue(fields.location)) {
    let location = cleanFieldValue(fields.location);
    if (!fields.mainConcern || !fields.mainConcern.toLowerCase().includes(location.toLowerCase())) {
      parts.push(`Location: ${location}`);
    }
  }

  if (isValidFieldValue(fields.symptoms)) {
    parts.push(cleanFieldValue(fields.symptoms));
  }

  if (isValidFieldValue(fields.whatHelps)) {
    let helps = cleanFieldValue(fields.whatHelps);
    parts.push(`${helps} is helping`);
  }

  if (isValidFieldValue(fields.whatWorsens)) {
    let worsens = cleanFieldValue(fields.whatWorsens);
    parts.push(`${worsens} makes it worse`);
  }

  if (isValidFieldValue(fields.medications)) {
    let meds = cleanFieldValue(fields.medications);
    parts.push(`Taking: ${meds}`);
  }

  if (isValidFieldValue(fields.notes)) {
    parts.push(cleanFieldValue(fields.notes));
  }

  if (parts.length > 0) {
    let result = parts.join('. ')
      .replace(/\s+/g, ' ')
      .replace(/\.\s*\./g, '.')
      .replace(/\s+is helping is helping/gi, ' is helping')
      .replace(/\s+makes it worse makes it worse/gi, ' makes it worse')
      .trim();
    if (!result.endsWith('.') && !result.endsWith('?')) result += '.';
    return result;
  }

  return options.emptyMessage || 'Your health summary will appear here as you share more details.';
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * HTML escape (XSS protection)
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate text to max length
 */
function truncate(text, maxLength = 120) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + '...';
}

/**
 * Format date for display
 */
function formatDate(date, lang = 'es') {
  const locales = { es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', en: 'en-US' };
  const options = { weekday: 'short', month: 'short', day: 'numeric' };
  return new Date(date).toLocaleDateString(locales[lang] || 'en-US', options);
}

/**
 * Format time for display
 */
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format relative date (Today, Yesterday, etc.)
 */
function formatRelativeDate(dateStr, translations) {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return translations?.today || 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return translations?.yesterday || 'Yesterday';
  }
  return formatDate(dateStr);
}

/**
 * Process medication list from string or array
 */
function processMedicationList(medsInput) {
  if (!medsInput) return [];
  if (Array.isArray(medsInput)) {
    return medsInput.map(m => m.trim()).filter(m => m && m.length > 0);
  }
  return medsInput.split(',').map(m => m.trim()).filter(m => m && m.length > 0);
}

/**
 * Convert medications array to string
 */
function medicationsToString(medsArray) {
  return medsArray.map(m => m.trim()).filter(m => m).join(', ');
}

// =============================================================================
// EXPORT (for module systems)
// =============================================================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CARELOG,
    parseHealthSummary,
    normalizeText,
    cleanFieldValue,
    isValidFieldValue,
    cleanForDisplay,
    buildNaturalSummary,
    escapeHtml,
    truncate,
    formatDate,
    formatTime,
    formatRelativeDate,
    processMedicationList,
    medicationsToString
  };
}
