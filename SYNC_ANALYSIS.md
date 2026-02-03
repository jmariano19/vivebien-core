# Data Sync Analysis - CareLog System

## Overview

This document analyzes the data synchronization flow between all components of the CareLog system.

## System Components

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────┐
│    WhatsApp     │────▶│   Database   │────▶│  Landing Page   │
│  (via Chatwoot) │     │  (memories)  │     │  (summary.html) │
└─────────────────┘     └──────────────┘     └─────────────────┘
                              │                      │
                              │                      ▼
                              │               ┌─────────────────┐
                              │               │   Update Page   │
                              │               │ (suggest.html)  │
                              │               └────────┬────────┘
                              │                        │
                              │◀───────────────────────┘
                              │
                              ▼
                        ┌─────────────────┐
                        │   Doctor Page   │
                        │  (doctor.html)  │
                        └─────────────────┘
```

---

## Data Flow Analysis

### 1. WhatsApp → Database (AI-Generated)

**Source**: `src/domain/ai/service.ts` → `generateSummary()`
**Storage**: `memories` table, `content` column (TEXT)

**Format Generated (Language-Specific Headers)**:
```
MOTIVO PRINCIPAL
Dolor de cabeza intenso

INICIO / DURACIÓN
Hace 3 días, episodios de 4-6 horas

PATRÓN / SEVERIDAD
Ocurre 2-3 veces por semana

QUÉ AYUDA / EMPEORA
- Helps: Descanso, compresas frías
- Worsens: Luz brillante, estrés

MEDICAMENTOS ACTUALES
- Paracetamol: 500mg según necesidad

PREGUNTAS PARA LA VISITA
- ¿Es normal esta frecuencia?
```

**Key Characteristics**:
- Section headers are in user's language (es, en, pt, fr)
- ALL CAPS headers with content on next line
- Newline-separated sections
- Preserves user's original medical descriptions

---

### 2. Update Page → Database (User-Edited)

**Source**: `public/suggest.html` → Save button
**Storage**: Same `memories` table

**Format Saved (ALWAYS English Labels)**:
```
Main concern: Dolor de cabeza intenso
Started: 3 days ago
Location: Head, temples
Symptoms: Throbbing pain, sensitivity to light
What helps: Rest, cold compress
What worsens: Bright lights, stress
Medications: Paracetamol
Notes: Gets worse in afternoons
```

**Key Characteristics**:
- Labels are ALWAYS in English (`Main concern:`, `Started:`, etc.)
- Single line per field with colon separator
- No ALL CAPS headers
- Simpler, flatter structure

---

## 🔴 CRITICAL ISSUE: Format Mismatch

The system has **TWO INCOMPATIBLE FORMATS** stored in the same database field:

| Source | Format | Headers | Structure |
|--------|--------|---------|-----------|
| WhatsApp/AI | Multi-language | `MOTIVO PRINCIPAL`, `INICIO`, etc. | Block sections |
| Update Page | English only | `Main concern:`, `Started:`, etc. | Key-value pairs |

**Impact**:
1. When user edits via Update page, the entire format changes
2. The next WhatsApp conversation may generate a THIRD corrupted format
3. Each component parses differently, causing display inconsistencies

---

## Component-by-Component Analysis

### Landing Page (`summary.html`)

**Parser**: `cleanSummaryForDisplay()`

**Current Status**: ⚠️ PARTIAL
- Handles clean Update-page format (`Main concern:` style)
- Extracts key info from AI format using patterns
- Falls back to extracting meaningful sentences
- **Issue**: Complex corrupted data (multiple format layers) causes garbage display

**Improvements Needed**:
- Better detection of which format is being used
- More aggressive cleanup of corrupted data

---

### Update Page (`suggest.html`)

**Load Parser**: `parseExistingSummary()`
**Save Format**: English key-value pairs

**Current Status**: ⚠️ PARTIAL
- Handles clean Update-page format well
- Has legacy patterns for AI format
- **Issue**: Doesn't fully extract all AI-generated fields

**Improvements Needed**:
- Better parsing of AI-generated `MOTIVO PRINCIPAL` style headers
- Language-aware parsing for Spanish/Portuguese/French headers

---

### Doctor Page (`doctor.html` + `doctor.ts`)

**Parser**: `parseSummaryToDoctorNote()` (backend)

**Current Status**: ✅ BEST
- Handles multiple formats with extensive regex patterns
- Multi-language header detection
- Graceful fallbacks for missing data

**Why it works better**:
- Backend parsing with TypeScript
- Extensive pattern matching for both formats
- Structured output object

---

## Recommendations

### Option A: Standardize on Single Format (Recommended)

**Change**: Make Update Page save in SAME format as AI generates

**Implementation**:
1. Update `suggest.html` to save with language-specific headers:
   ```javascript
   // Instead of: "Main concern: X"
   // Save as: "MOTIVO PRINCIPAL\nX" (for Spanish)
   ```

2. Or better: Save as structured JSON:
   ```json
   {
     "mainConcern": "Dolor de cabeza",
     "started": "3 days ago",
     "location": "Head",
     ...
   }
   ```

**Pros**:
- Single parsing logic everywhere
- No format confusion
- Easier to maintain

**Cons**:
- Requires updating all parsers
- Need to migrate existing data

---

### Option B: Universal Parser (Current Approach)

**Keep**: Multiple formats, but improve ALL parsers

**Implementation**:
1. Create shared parsing logic used by ALL pages
2. Move parsing to backend API (like doctor.ts does)
3. Frontend just displays structured data

**Pros**:
- Backward compatible
- No data migration needed

**Cons**:
- Complex parsing logic in multiple places
- Easy to miss edge cases

---

### Option C: Structured Storage (Best Long-Term)

**Change**: Store structured data in database, not free text

**Implementation**:
1. Create new table or JSON column:
   ```sql
   CREATE TABLE health_summaries (
     id UUID PRIMARY KEY,
     user_id UUID NOT NULL,
     main_concern TEXT,
     started TEXT,
     location TEXT,
     symptoms TEXT,
     what_helps TEXT,
     what_worsens TEXT,
     medications TEXT[],
     notes TEXT,
     raw_ai_summary TEXT,  -- Keep original for reference
     created_at TIMESTAMPTZ
   );
   ```

2. AI generates → Parse and store structured
3. Update page → Updates individual fields
4. Display pages → Read structured fields directly

**Pros**:
- No parsing needed on display
- Data integrity
- Easy querying/analytics

**Cons**:
- Database migration required
- More complex AI post-processing

---

## Immediate Fixes Needed

### Fix 1: Update Page Should Detect and Preserve Format

When loading existing AI-generated summary, the Update page should:
1. Detect the format type
2. Parse into fields for editing
3. **Save back in the SAME format it was loaded in**

### Fix 2: Unified Display Cleaning

All pages should use the SAME cleaning/display logic. Options:
- Move `cleanSummaryForDisplay()` to backend API
- Create shared JavaScript module imported by all pages

### Fix 3: Better Corruption Handling

When data is corrupted (multiple formats layered), pages should:
1. Detect corruption (repeated labels, mixed formats)
2. Extract only FIRST valid value for each field
3. Display clean subset rather than garbage

---

## Data Flow Diagram (Current vs Ideal)

### Current (Problematic)
```
WhatsApp ──AI──▶ "MOTIVO PRINCIPAL\n..." ──▶ Database
                                                │
Update Page ───▶ "Main concern: ..." ──────────▶│ (OVERWRITES!)
                                                │
Landing Page ◀────── Mixed formats ─────────────┘
Doctor Page  ◀────── (parses OK)
```

### Ideal (Structured)
```
WhatsApp ──AI──▶ Parse ──▶ Structured JSON ──▶ Database
                                                  │
Update Page ──────────▶ Update fields ───────────▶│
                                                  │
Landing Page ◀────────── Read fields ─────────────┘
Doctor Page  ◀────────── Read fields
```

---

## Action Items

1. **Short-term**: Improve `cleanSummaryForDisplay()` to handle all formats
2. **Medium-term**: Add format detection to Update page, preserve on save
3. **Long-term**: Migrate to structured storage (Option C)

---

## Files to Modify

| File | Change Needed |
|------|---------------|
| `public/summary.html` | Improve `cleanSummaryForDisplay()` |
| `public/suggest.html` | Add format detection, preserve format on save |
| `src/api/routes/summary.ts` | Add GET endpoint that returns PARSED data |
| `public/doctor.html` | Already good (uses backend parsing) |

