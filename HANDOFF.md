# ViveBien Core - Project Handoff

## Project Overview
**ViveBien Core** is a scalable backend service for a WhatsApp-based wellness platform. Users chat via WhatsApp to log health symptoms, and the AI assistant (CareLog) helps them prepare summaries for doctor visits.

## Architecture
```
WhatsApp → Chatwoot → vivebien-core API → BullMQ → Workers → Claude AI
                              ↓                        ↓
                         PostgreSQL              OpenAI Whisper (voice)
                            + Redis              Claude Vision (images)
```

**NOTE: n8n is NO LONGER required.** All webhooks and processing are handled directly by the API.

### Flow:
1. User sends WhatsApp message (text, voice, or image)
2. Chatwoot receives it, triggers webhook to `https://carelog.vivebien.io/ingest/chatwoot`
3. API queues job to BullMQ (Redis)
4. vivebien-core-worker picks up job:
   - Voice messages → OpenAI Whisper transcription (auto-detect language)
   - Images → Claude Vision analysis
   - Text → Direct processing
5. Worker processes with Claude AI
6. Worker sends response back via Chatwoot API
7. Summary is saved to memories table for landing page

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript
- **Framework**: Fastify
- **Queue**: BullMQ (Redis)
- **Database**: PostgreSQL 16+
- **Cache**: Redis 7+
- **AI**: Anthropic Claude API (conversations + image analysis)
- **Voice**: OpenAI Whisper API (transcription)
- **Messaging**: Chatwoot (WhatsApp integration)

## Infrastructure

### Easypanel Services (projecto-1)
| Service | Purpose |
|---------|---------|
| vivebien-core-api | API server, receives webhooks, serves landing page |
| vivebien-core-worker | Processes messages, calls AI, sends responses |
| vivebien-staging | Staging environment |

**⚠️ IMPORTANT**: When deploying code changes, you must deploy BOTH vivebien-core-api AND vivebien-core-worker!

### Database (PostgreSQL)
- **Host**: 85.209.95.19:5432
- **Database**: projecto-1
- **User**: postgres
- **Password**: bd894cefacb1c52998f3
- **pgweb UI**: https://projecto-1-postgress-pgweb.yydhsb.easypanel.host/

### Deploy Webhooks
- **Core API**: http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22
- **Core Worker**: http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548

### Key Tables
| Table | Purpose |
|-------|---------|
| users | User records (id, phone, language, name) |
| messages | Conversation history |
| memories | Health summaries (category='health_summary') — legacy, still updated for backward compat |
| conversation_state | Current phase, message count |
| health_concerns | Individual health concerns per user (title, status, summary_content, icon) |
| concern_snapshots | History of changes per concern (content, change_type, status at time) |

## Repository Structure
```
vivebien-project/
├── src/
│   ├── index.ts                 # API server entry point + page routes
│   ├── config.ts                # Environment config (includes OPENAI_API_KEY)
│   ├── api/routes/
│   │   ├── ingest.ts            # Webhook endpoint (/ingest/chatwoot)
│   │   ├── summary.ts           # Summary API (GET & PUT /api/summary/:userId)
│   │   ├── concerns.ts          # Concerns API (CRUD /api/concerns/:userId)
│   │   ├── doctor.ts            # Doctor API (/api/doctor/:userId)
│   │   ├── test.ts              # Automated pressure test endpoint (/api/test)
│   │   └── health.ts            # Health check
│   ├── domain/
│   │   ├── ai/service.ts        # AI service, postProcess(), summary link, detectConcernTitle()
│   │   ├── concern/service.ts   # ConcernService (multi-concern CRUD + snapshots)
│   │   ├── conversation/service.ts  # System prompts, updateHealthSummary() (multi-concern)
│   │   ├── media/service.ts     # Voice transcription (Whisper) + Image analysis (Vision)
│   │   └── user/service.ts      # User CRUD
│   ├── shared/
│   │   ├── language.ts          # detectLanguage(), extractUserName(), extractNameFromAIResponse()
│   │   ├── types.ts             # Shared TypeScript interfaces
│   │   └── errors.ts            # Error classes
│   ├── worker/
│   │   ├── index.ts             # Worker entry point
│   │   └── handlers/inbound.ts  # Main message handler (imports from shared/language.ts)
│   └── adapters/chatwoot/client.ts  # Chatwoot API client
├── public/
│   ├── index.html               # Admin dashboard
│   ├── summary.html             # Landing page (/{userId}) — multi-concern cards
│   ├── doctor.html              # Doctor view (/doctor/{userId}) — clinical format
│   ├── appointment.html         # Appointment prep (/appointment/{userId})
│   ├── suggest.html             # Edit summary (/suggest/{userId}) — per-concern editing + status selector
│   ├── history.html             # View history (/history/{userId}) — supports ?concern= filter
│   └── questions.html           # Questions for Doctor (/questions/{userId}) — recommended + custom questions
├── Dockerfile
└── package.json
```

---

## Voice & Image Support (NEW - Feb 5, 2026)

### Voice Messages
Users can send voice messages via WhatsApp. The system:
1. Receives audio attachment from Chatwoot webhook
2. Downloads audio file
3. Transcribes using OpenAI Whisper (auto-detects language)
4. Includes transcription in AI context as `[Voice message]: {transcription}`
5. AI responds based on transcribed content

**Key Implementation:**
- File: `src/domain/media/service.ts`
- Method: `transcribeAudio(audioUrl: string)`
- Model: `whisper-1`
- **Language**: Auto-detected (NOT forced from user profile)

### Image Analysis
Users can send images via WhatsApp. The system:
1. Receives image attachment from Chatwoot webhook
2. Downloads and converts to base64
3. Analyzes using Claude Vision (Sonnet 4.5)
4. Includes analysis in AI context as `[Image description]: {analysis}`
5. AI responds based on image content

**Key Implementation:**
- File: `src/domain/media/service.ts`
- Method: `analyzeImage(imageUrl: string, language: string)`
- Model: `claude-sonnet-4-5-20250929`
- Prompts: Health-focused analysis in user's language

### Attachment Processing Flow
```typescript
// src/worker/handlers/inbound.ts
async function processAttachments(attachments, message, language, logger) {
  for (const attachment of attachments) {
    if (attachment.type === 'audio') {
      const transcription = await mediaService.transcribeAudio(attachment.url);
      // Add as [Voice message]: {transcription}
    } else if (attachment.type === 'image') {
      const analysis = await mediaService.analyzeImage(attachment.url, language);
      // Add as [Image description]: {analysis}
    }
  }
}
```

### Language Detection for Voice Messages
- Whisper auto-detects the spoken language (no hints passed)
- After transcription, language is detected from the transcribed text
- User's language preference is updated if different
- AI responds in the detected language

---

## Multi-Concern Health Tracking (NEW - Feb 5, 2026)

### Overview
CareLog now tracks multiple health concerns per user instead of a single summary. Each concern has its own status lifecycle and change history (snapshots).

### How It Works
1. User chats about a health topic (e.g., "I have back pain")
2. AI detects the concern title via Claude Haiku (`detectConcernTitle()`)
3. System fuzzy-matches against existing concerns or creates a new one
4. Summary is generated per-concern and stored in `health_concerns.summary_content`
5. If the content changed meaningfully, a snapshot is created in `concern_snapshots`
6. Legacy `memories` table is also updated for backward compatibility

### Status Lifecycle
- **active** (green) — Currently being tracked
- **improving** (blue) — User reports improvement
- **resolved** (gray) — No longer an active concern

### Database Tables

**health_concerns:**
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | Primary key |
| user_id | UUID | References users(id) |
| title | VARCHAR(255) | Short topic name ("Back pain", "Eye sty") |
| status | VARCHAR(20) | active, improving, or resolved |
| summary_content | TEXT | Current structured summary |
| icon | VARCHAR(10) | Emoji icon for display |
| created_at | TIMESTAMPTZ | When concern was first tracked |
| updated_at | TIMESTAMPTZ | Last update time |

**concern_snapshots:**
| Column | Type | Purpose |
|--------|------|---------|
| id | UUID | Primary key |
| concern_id | UUID | References health_concerns(id) ON DELETE CASCADE |
| user_id | UUID | User ID for indexing |
| content | TEXT | Full summary at this point in time |
| change_type | VARCHAR(30) | auto_update, user_edit, or status_change |
| status | VARCHAR(20) | Status at time of snapshot |
| created_at | TIMESTAMPTZ | When snapshot was created |

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/concerns/:userId` | All concerns for a user |
| GET | `/api/concerns/:userId/:concernId` | Single concern detail |
| PUT | `/api/concerns/:userId/:concernId` | Update summary/title (from edit page) |
| PUT | `/api/concerns/:userId/:concernId/status` | Change status (active/improving/resolved) |
| DELETE | `/api/concerns/:userId/:concernId` | Delete concern + all snapshots |
| GET | `/api/concerns/:userId/:concernId/history` | Snapshot timeline for a concern |

### Key Files
- `src/domain/concern/service.ts` — ConcernService with all CRUD + fuzzy matching + meaningful change detection
- `src/domain/ai/service.ts` — `detectConcernTitle()` uses Claude Haiku for fast topic extraction
- `src/domain/conversation/service.ts` — `buildMessages()` injects all active concerns as context; `updateHealthSummary()` routes to correct concern
- `src/api/routes/concerns.ts` — REST API for concerns
- `migrations/003_health_concerns.sql` — Database migration (already applied)

### Frontend Pages (Updated Feb 6, 2026)
- **summary.html** — Redesigned per Figma. Multi-concern cards with status badges (Ongoing/Improving/Resolved), expand/collapse, History + Update CTAs. History link passes `?concern=` param for concern-specific filtering.
- **history.html** — Concern tabs + snapshot timeline. Deduplication: only latest snapshot per concern per day. Supports `?concern={id}` URL param to pre-select a specific concern tab.
- **suggest.html** — Per-concern editing with `?concernId=X&returnTo=history`. Status selector field with interactive pill buttons (Ongoing/Improving/Resolved). Saves status via `PUT /api/concerns/:userId/:concernId/status`.
- **doctor.html** — Redesigned per Figma. Each concern rendered as separate clinical section. Parses AI summaryContent into motivo, HPI, síntomas asociados, medidas, objetivos.
- **questions.html** — NEW. Questions for your Doctor page. Shows recommended questions (5 per language) as defaults, plus custom questions from doctor API objetivos field. Users can add/delete questions.

### AI summaryContent Format
The AI generates `summaryContent` for each concern using up to 9 fields with localized labels. Only fields with actual data are included (typically 4-7 fields):

```
Concern: [description]         (ES: Motivo: / PT: Queixa: / FR: Motif:)
Started: [when]                (ES: Inicio: / PT: Início: / FR: Début:)
Location: [where]              (ES: Ubicación: / PT: Localização: / FR: Localisation:)
Character: [quality/sensation] (ES: Carácter: / PT: Caráter: / FR: Caractère:)
Severity: [how bad]            (ES: Severidad: / PT: Gravidade: / FR: Sévérité:)
Pattern: [timing/frequency]    (ES: Patrón: / PT: Padrão: / FR: Schéma:)
Helps: [what helps]            (ES: Mejora con: / PT: Melhora com: / FR: Améliore:)
Worsens: [what worsens]        (ES: Empeora con: / PT: Piora com: / FR: Aggrave:)
Medications: [meds]            (ES: Medicamentos: / PT: Medicamentos: / FR: Médicaments:)
```

**IMPORTANT**: All frontend parsers (doctor.html, suggest.html, questions.html, summary.html, history.html) must match this format. The parsers use regex to detect each label variant across all 4 languages. Fields are optional — old 5-field summaries are backward compatible.

### Page Routes (src/index.ts)
```
GET /{userId}                → summary.html
GET /doctor/{userId}         → doctor.html
GET /suggest/{userId}        → suggest.html
GET /history/{userId}        → history.html
GET /questions/{userId}      → questions.html
GET /appointment/{userId}    → appointment.html
```

### Backward Compatibility
- `GET /api/summary/:userId` still works and now includes a `concerns` array alongside the existing `summary` field
- Legacy `memories` table is still updated on every summary generation
- Frontend gracefully falls back to single-summary mode if no concerns exist

---

## Chatwoot Webhook Integration (Updated Feb 5, 2026)

### Webhook Configuration
- **URL**: `https://carelog.vivebien.io/ingest/chatwoot`
- **Events**: Message created (message_created)
- **Method**: POST

**⚠️ IMPORTANT**: Do NOT use `vivebien-core-api.srv818872.hstgr.cloud` - it has SSL certificate issues. Always use `carelog.vivebien.io`.

### Webhook Endpoint
```typescript
// src/api/routes/ingest.ts
app.post('/ingest/chatwoot', async (request, reply) => {
  // Flexible payload parsing (no strict Zod validation)
  // Extracts: event, message_type, content, conversation, sender, attachments
  // Queues job to BullMQ for processing
});
```

### Payload Structure
```typescript
interface ChatwootWebhook {
  event?: string;              // "message_created"
  message_type?: string;       // "incoming" or "outgoing"
  content?: string;            // Text content (may be null for voice/image only)
  conversation?: {
    id?: number;
    contact_inbox?: { source_id?: string };
  };
  sender?: {
    id?: number;
    phone_number?: string;
    identifier?: string;       // WhatsApp format: "1234567890@s.whatsapp.net"
  };
  attachments?: Array<{
    file_type?: string;        // "audio", "image", etc.
    data_url?: string;         // URL to download attachment
  }>;
}
```

---

## n8n Usage

**n8n is NOT required for CareLog's core functionality** (messaging, AI, webhooks). However, n8n IS used for database access via MCP.

### n8n Database Access (Active)
The `SQL_Runner` workflow provides direct PostgreSQL access via MCP:
- **Workflow ID**: `rWG8DN8q_HT9q6EZ_wFel`
- **Trigger**: Webhook (POST)
- **Input**: `{ "query": "SQL statement here" }`
- **Use for**: Deleting test users, querying data, debugging

### What n8n Is NOT Used For
- ❌ Chatwoot webhook relay → Handled by `/ingest/chatwoot` endpoint
- ❌ Voice transcription → Handled by MediaService (Whisper)
- ❌ Image analysis → Handled by MediaService (Claude Vision)
- ❌ Message processing → Handled by BullMQ workers

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| API_SECRET_KEY | Admin/test API authentication (min 16 chars) | ✅ Yes |
| ANTHROPIC_API_KEY | Claude API key | ✅ Yes |
| OPENAI_API_KEY | OpenAI API key (for Whisper) | ✅ Yes (for voice) |
| DATABASE_URL | PostgreSQL connection string | ✅ Yes |
| REDIS_URL | Redis connection string | ✅ Yes |
| CHATWOOT_URL | Chatwoot instance URL | ✅ Yes |
| CHATWOOT_API_KEY | Chatwoot API token | ✅ Yes |
| CHATWOOT_ACCOUNT_ID | Chatwoot account ID | ✅ Yes |
| PORT | API server port (default: 3000) | No |

---

## Key Code Locations

### Media Service (Voice + Images)
- **File**: `src/domain/media/service.ts`
- **Methods**:
  - `transcribeAudio(audioUrl)` - Whisper transcription
  - `analyzeImage(imageUrl, language)` - Claude Vision analysis

### Inbound Handler (Message Processing)
- **File**: `src/worker/handlers/inbound.ts`
- **Key Functions**:
  - `handleInboundMessage()` - Main entry point
  - `processAttachments()` - Handles voice/image attachments
- **Imports from `src/shared/language.ts`**: `detectLanguage()`, `extractUserName()`, `extractNameFromAIResponse()`

### Shared Language Utilities
- **File**: `src/shared/language.ts`
- **Functions** (used by both inbound handler and test endpoint):
  - `detectLanguage(message)` — Detects es/en/pt/fr from word frequency scoring
  - `extractUserName(message, recentMessages)` — Extracts name from user message (proactive + response-to-ask)
  - `extractNameFromAIResponse(aiResponse)` — Backup: extracts name from AI acknowledgments ("Merci Marie,")

### Webhook Endpoint
- **File**: `src/api/routes/ingest.ts`
- **Endpoint**: `POST /ingest/chatwoot`
- **Also supports**: `POST /api/ingest` (backwards compatibility)

### Summary Split Delivery (3-Message Flow)
When AI generates a health note, it's delivered as 3 separate WhatsApp messages with timed delays.

**Flow:**
1. **Ack** (immediate): "That's helpful — I've noted that coffee doesn't seem to help."
2. **Health Note** (10s delay): 📋 *Your Health Note* + fields + containment text + link
3. **Name Ask** (5s delay, only if no name): "By the way, what's your name? Totally optional."

**Files:**
1. `src/domain/ai/service.ts`
   - `postProcess()` — Basic cleaning only (bold conversion, code block removal)
   - `looksLikeSummary()` — Detects summary responses (2+ indicators: 📋 emoji, field labels in all 4 languages)
   - `splitSummaryResponse()` — Splits at 📋 marker into ack + summary parts
   - `stripContainmentText()` — Removes AI containment to avoid duplication
   - `buildSummaryMessage()` — Appends containment text + link to summary
   - `getNameAskMessage()` — Localized name ask (ES/EN/PT/FR)
   - `getSummaryLinkText()` — Localized link: 📋 *Your note is here* 👇

2. `src/domain/conversation/service.ts`
   - `getDefaultSystemPrompt()` — 7-principle containment-first prompt
   - `updateHealthSummary()` — Multi-concern summary + legacy aggregation

3. `src/worker/handlers/inbound.ts`
   - Steps 8-8.5: Clean response, detect summary, determine split strategy
   - Step 12: Split delivery (ack → 10s delay → note+link → 5s delay → name ask)
   - Step 16: Delayed name ask saved to history for `extractUserName()` detection

### Landing Page (Patient Summary)
- **URL**: https://carelog.vivebien.io/{userId}
- **HTML**: public/summary.html
- **API**: GET /api/summary/:userId
- **Data**: memories table where category = 'health_summary'

### Doctor View Page
- **URL**: https://carelog.vivebien.io/doctor/{userId}
- **HTML**: public/doctor.html
- **API**: /api/doctor/:userId
- **Purpose**: Clinically-formatted, doctor-ready handoff document

---

## Current State (Feb 8, 2026)

### Working:
- ✅ WhatsApp conversations via Chatwoot (direct, no n8n)
- ✅ Voice message transcription (OpenAI Whisper with auto language detection)
- ✅ Image analysis (Claude Vision)
- ✅ AI responses with Claude (Opus 4.5 for conversations, Sonnet for summaries)
- ✅ CareLog onboarding flow (value-first, AI disclosure after summary)
- ✅ Summary generation in chat with WhatsApp formatting
- ✅ Summary link after summaries (localized): 📋 View my summary 👇 + URL
- ✅ Landing page at carelog.vivebien.io/{userId} — redesigned per Figma with expandable concern cards
- ✅ Doctor view page at carelog.vivebien.io/doctor/{userId} — redesigned per Figma, clinical sections per concern
- ✅ Appointment preparation page at carelog.vivebien.io/appointment/{userId}
- ✅ Edit Summary page at carelog.vivebien.io/suggest/{userId} — per-concern editing with interactive status selector
- ✅ View History page at carelog.vivebien.io/history/{userId} — deduped snapshots, supports ?concern= deep linking
- ✅ Questions page at carelog.vivebien.io/questions/{userId} — recommended + custom questions per language
- ✅ Multi-concern health tracking with status lifecycle (active → improving → resolved)
- ✅ Concern change history with snapshots (auto_update, user_edit, status_change)
- ✅ Concerns API (/api/concerns/:userId) with full CRUD + status update
- ✅ Multi-language support (es, en, pt, fr) — all frontend pages and parsers support all 4 languages
- ✅ Language auto-detection from user messages AND voice
- ✅ Name extraction from conversations (proactive + backup from AI response)
- ✅ WhatsApp bold formatting (*text*)
- ✅ 24-hour check-in feature
- ✅ Direct database access (no n8n required)
- ✅ n8n DevOps Gateway available for database operations via MCP
- ✅ Automated pressure test endpoint (/api/test) for testing AI pipeline without WhatsApp
- ✅ Concern deduplication (existing titles passed to detectConcernTitle, multi-symptom grouping)

### Recent Changes (Feb 7-8, 2026):

#### Automated Pressure Test System (Feb 8)
- New test API endpoint at `src/api/routes/test.ts` — runs AI pipeline without Chatwoot
- `POST /api/test/message` and `DELETE /api/test/user` endpoints, protected by API_SECRET_KEY
- Includes language detection, name extraction, summary generation — mirrors production flow
- Enables Claude to automatically: clean user → send messages → analyze results → fix issues → redeploy

#### Shared Language Utilities (Feb 8)
- Moved `detectLanguage()`, `extractUserName()`, `extractNameFromAIResponse()` from `inbound.ts` to `src/shared/language.ts`
- Both inbound handler and test endpoint import from the shared module
- Added `extractNameFromAIResponse()` — backup name extraction from AI acknowledgments (e.g., "Merci Marie," → "Marie")

#### French vs Portuguese Label Fix (Feb 8)
- AI was confusing French and Portuguese note labels (using "Queixa" instead of "Motif" in French conversations)
- Added explicit per-language label lists in the system prompt CRITICAL rule with clear disambiguation warnings

#### Concern Deduplication (Feb 7)
- `detectConcernTitle()` now receives existing concern titles as context — reuses exact title if same condition
- Includes first user message as anchor (prevents drift as conversation shifts focus)
- Multi-symptom grouping rule: related symptoms (insomnia + palpitations + weight loss) are ONE concern
- Fixed: French conversation no longer creates 3 separate concerns for related symptoms

#### Duplicate Containment Fix (Feb 7)
- System prompt Principle 5 now explicitly tells AI NOT to add containment text after the health note
- System (`buildSummaryMessage`) handles containment — AI adding its own caused duplicate messages

#### Portuguese/French Note Templates (Feb 7)
- Added explicit Portuguese and French note templates to the system prompt
- Previously only English and Spanish were templated, causing AI to use Spanish labels in Portuguese/French conversations

### Recent Changes (Feb 6, 2026):

#### Containment-First Philosophy Rewrite (Feb 6, session 2)
Complete rewrite of the conversation engine based on the CareLog design philosophy: "CareLog is a containment system for human health uncertainty."

**System Prompt** (`conversation/service.ts`):
- Rewrote `getDefaultSystemPrompt()` with 7 design principles: start where user is, ask only high-signal questions, contain uncertainty don't resolve it, summarize early then refine, explicitly offload mental burden, identity handled automatically by system, encourage return without pressure
- Tone: calm, grounded, reassuring without false reassurance
- Success criteria: "If the flow feels impressive but not calming, it has failed"

**3-Message Split Delivery** (`worker/handlers/inbound.ts`):
When the AI generates a health note summary, the response is split into 3 separate WhatsApp messages:
1. **Message 1** (immediate): Conversational acknowledgment ("That's helpful — I've noted that...")
2. **Message 2** (10s delay): Health note + containment text + landing page link
3. **Message 3** (5s delay): Name ask ("By the way, what's your name? I'll personalize your Health Note. Totally optional.")

Key implementation:
- `aiService.splitSummaryResponse()` — splits at 📋 marker, strips AI containment text
- `aiService.buildSummaryMessage()` — adds containment + link programmatically
- `aiService.getNameAskMessage()` — 4-language name ask
- `aiService.looksLikeSummary()` — detects summary responses (2+ indicators including 📋, field labels in all 4 languages)
- Name ask only sent if user doesn't have a name yet
- Name ask saved to message history so `extractUserName()` can detect responses
- Delays use `setTimeout` within the BullMQ handler (lock duration is 120s, well within limits)

**AI Service Changes** (`ai/service.ts`):
- Moved containment+link out of `postProcess()` — now handled by inbound handler for split control
- `postProcess()` is now basic cleaning only (markdown→WhatsApp bold, remove code blocks, limit length)
- Added `stripContainmentText()` to remove AI-generated containment before adding system containment
- Bold link text: `📋 *Your note is here* 👇`
- System prompt Principle 6 tells AI NOT to ask for name (system handles it automatically)
- **Fixed `looksLikeSummary()` detection** — Expanded from 16 to 30+ indicators, lowered threshold from 3 to 2. Added 📋 emoji, 'health note'/'nota de salud', and all field labels (started:/helps:/worsens:/medications: + ES/PT/FR equivalents). Previously only matched 1 indicator for English responses (just 'concern'), which prevented summary detection and broke split delivery.
- **Fixed AI URL hallucination** — Added rule in system prompt: "If the user asks where their note is, tell them the system will send a link. Do NOT make up URLs."

**Check-in Service** (`checkin/service.ts`):
- Rewrote to permission-based continuity instead of push-based re-engagement
- "Your note is still here, organized and ready. If anything has changed, you can tell me."

**Doctor API** (`api/routes/doctor.ts`):
- Updated to fetch from `health_concerns` table as primary source
- Returns per-concern parsed data (motivo, HPI, síntomas, medidas, objetivos)

**Summary Landing Page** (`public/summary.html`):
- Fixed concern cards to use `parseAnyFormat()` for structured field display
- Fallback to paragraph only when no fields parse

**Legacy Memories Aggregation** (`conversation/service.ts`):
- `updateHealthSummary()` Step 5 now aggregates ALL active concerns into legacy memories
- Uses `--- Title ---` separators between concerns

#### Frontend Redesign per Figma (Feb 6)
- **summary.html**: Redesigned per Figma node 105-66. Expandable concern cards with status badges, date headers, History/Update CTAs. History link now passes `?concern=` param for concern-specific filtering.
- **doctor.html**: Redesigned per Figma node 105-112. Each concern as clinical section with motivo, HPI, síntomas, medidas, objetivos. Parser rewritten to match actual AI summaryContent format.
- **questions.html**: NEW page per Figma node 105-298. Recommended questions (5 per language: ES/EN/PT/FR), custom question add/delete, fetches doctor API for objetivos.
- **suggest.html**: Added interactive status selector (Ongoing/Improving/Resolved pill buttons) inside the edit form. Saves status via `PUT /api/concerns/:userId/:concernId/status`.
- **history.html**: Added dedup logic (latest snapshot per concern per day only). Added `?concern=` URL parameter support for deep linking from summary page.

#### Data Parsing Alignment (Feb 6)
- All frontend parsers (doctor.html, suggest.html, questions.html) rewritten to match the actual AI 5-line summaryContent format
- Added Portuguese (Melhora com, Piora com) and French (Améliore, Aggrave) variants to all parsers
- Fixed stray `:` prefix in concern value HTML

#### New Routes (Feb 6)
- Added `/questions/:userId` route in `src/index.ts` for the new questions page

#### Design System
- **Fonts**: Outfit (headings/UI) + Lora (body text) ONLY
- **Colors**: `--bg: #F9F6F0`, `--primary: #2E915E`, `--btn-color: #216F64`, `--text: #373737`
- **Figma file key**: `UgbafTWqp5i0sMZgT9GMrE`

### Earlier Changes (Feb 5, 2026):

#### Multi-Concern Health Tracking
- New tables: `health_concerns` and `concern_snapshots` (migration: `003_health_concerns.sql`)
- New service: `ConcernService` at `src/domain/concern/service.ts`
- New API: `/api/concerns/:userId` with full CRUD + history
- AI-powered concern detection: `detectConcernTitle()` using Claude Haiku
- Fuzzy title matching (exact, substring, 50% word overlap) to avoid duplicate concerns
- Meaningful change detection before creating snapshots
- All 4 frontend pages redesigned for multi-concern support
- Backward compatible: legacy `memories` table still updated, old API still works

#### Voice & Image Support
- Added MediaService for voice transcription and image analysis
- Voice: OpenAI Whisper with auto-language detection
- Images: Claude Vision (Sonnet 4.5) with health-focused prompts
- Files: `src/domain/media/service.ts`, `src/worker/handlers/inbound.ts`

#### n8n Removal
- Chatwoot webhooks now go directly to API
- Removed dependency on n8n for all core functionality
- Webhook URL: `https://carelog.vivebien.io/ingest/chatwoot`

#### Flexible Webhook Parsing
- Removed strict Zod validation that was causing 400 errors
- Added flexible TypeScript interface for Chatwoot payloads
- Phone extraction from multiple possible payload locations
- File: `src/api/routes/ingest.ts`

#### Language Detection Improvements
- Process voice transcription BEFORE language detection
- Always re-detect language from voice messages
- Extended detection window to first 5 messages
- Whisper auto-detects language (no hints passed)
- File: `src/worker/handlers/inbound.ts`

#### SSL Fix
- Use `carelog.vivebien.io` for webhook URL (not srv818872.hstgr.cloud)
- The hstgr.cloud domain has SSL certificate issues

---

## Testing

### Test Phone: +12017370113

### Deleting Test Users (Database Cleanup)

**Use `psql` for direct database access** (preferred) or n8n SQL_Runner as a backup.

**⚠️ IMPORTANT**: Foreign keys do NOT cascade on the users table. You must delete child records first. When asked to "delete test number" or "clean up test data", run these queries in order:

```sql
-- Step 1: Look up the user ID
SELECT id FROM users WHERE phone = '+12017370113';

-- Step 2: Delete child records (use the UUID from step 1)
DELETE FROM messages WHERE user_id = '{uuid}';
DELETE FROM health_concerns WHERE user_id = '{uuid}';
DELETE FROM memories WHERE user_id = '{uuid}';
DELETE FROM conversation_state WHERE user_id = '{uuid}';
DELETE FROM experiment_assignments WHERE user_id = '{uuid}';
DELETE FROM credit_transactions WHERE user_id = '{uuid}';

-- Step 3: Delete the user
DELETE FROM users WHERE id = '{uuid}';
```

**With psql**, multiple statements can be run in one call. With n8n SQL_Runner, each query must be run separately.

**NOTE**: Sending a new WhatsApp message after deletion will auto-recreate the user via `loadOrCreate()`. This is expected — the user gets a fresh record with 100 credits.

### n8n SQL_Runner Usage (via MCP)
```json
{
  "type": "webhook",
  "webhookData": {
    "body": {
      "query": "SELECT * FROM users WHERE phone = '+12017370113'"
    }
  }
}
```
Workflow ID: `rWG8DN8q_HT9q6EZ_wFel`

### Test Scenarios:
1. **Text message**: Send "Hello" → Should respond in English
2. **Voice message in English**: Record "I have pain in my left eye" → Should transcribe and respond in English
3. **Voice message in Spanish**: Record "Tengo dolor de cabeza" → Should transcribe and respond in Spanish
4. **Image**: Send photo of medication → Should analyze and describe
5. **Summary split test**: After enough info shared, AI should send 3 separate messages: ack (immediate) → health note (10s) → name ask (5s)

### Automated Pressure Test System (NEW - Feb 8, 2026)

The test API endpoint allows running the full AI pipeline without WhatsApp/Chatwoot. Protected by `API_SECRET_KEY` auth.

**Endpoints:**
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/test/message` | Send a message through the AI pipeline |
| DELETE | `/api/test/user` | Delete test user + all child records |

**File**: `src/api/routes/test.ts`

**How it works:**
- `POST /api/test/message` accepts `{ phone, message }` and runs: load user → detect language → load context → build messages → AI call → save messages → extract name → update summary
- Returns: `{ aiResponse, user: { id, name, language }, messageCount, concerns: [{ title, status, summaryContent }] }`
- `DELETE /api/test/user` accepts `{ phone }` and deletes user + all child records in a transaction

**Auth**: `Authorization: Bearer <API_SECRET_KEY>` or `X-API-Key: <API_SECRET_KEY>`

**How Claude runs a pressure test:**
1. Pick a test scenario (tough multilingual, multi-symptom)
2. `DELETE /api/test/user` to clean state
3. Send 4-5 messages via `POST /api/test/message`, reading AI responses and answering dynamically
4. Validate results against checklist:
   - Single concern card? (not split into multiple)
   - Correct language labels? (no mixing across ES/EN/PT/FR)
   - Name extracted? (if provided)
   - Standard fields only? (no invented labels like "Síntomas asociados")
   - Adequate field count? (4-7 expected)
   - No duplicate containment text?
5. If issues found → fix code → deploy → re-test

**Example curl:**
```bash
# Clean test user
curl -X DELETE "https://carelog.vivebien.io/api/test/user" \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+12017370113"}'

# Send test message
curl -X POST "https://carelog.vivebien.io/api/test/message" \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+12017370113","message":"Bonjour, j'\''ai mal à la tête depuis hier"}'
```

**What the test endpoint does NOT test:**
- WhatsApp delivery (Chatwoot integration)
- Voice/image attachments
- Credit system
- Safety detection flow
- The actual user experience timing (delays, split messages)

These still require manual WhatsApp testing.

---

## Deployment

### ⚠️ IMPORTANT: Deploying Changes to Production

**BOTH services must be deployed after ANY code change!** The API and Worker share the same codebase but run as separate services.

### Auto-Deploy Pipeline (GitHub → Easypanel)

Pushing to `main` automatically deploys both services:

1. Code is pushed to `main` branch on GitHub
2. GitHub Actions workflow (`.github/workflows/deploy.yml`) runs automatically
3. The workflow calls both Easypanel deploy webhooks (stored as GitHub secrets)
4. Easypanel rebuilds both Core API and Core Worker Docker containers

**GitHub Secrets:**
- `EASYPANEL_DEPLOY_CORE_API` — Core API deploy webhook
- `EASYPANEL_DEPLOY_CORE_WORKER` — Core Worker deploy webhook

### Deploy Process (for Claude)
To deploy changes, simply commit and push to `main`:
```bash
git add <files>
git commit -m "Description of changes"
git push origin main
```
Both API + Worker deploy automatically — no manual steps needed.

### GitHub CLI Access
- `gh` CLI is installed via Homebrew at `/opt/homebrew/bin/gh`
- Authenticated as **jmariano19** via `gh auth login`
- If `gh` is not in PATH, use full path: `/opt/homebrew/bin/gh`

### Deployment Checklist

After making changes:
- [ ] Commit changes to git
- [ ] Push to GitHub (`git push origin main` — auto-deploy handles the rest)
- [ ] Wait ~30 seconds for builds to complete
- [ ] **Clear browser cache** or use incognito tab to verify (static HTML files are cached aggressively)
- [ ] Test the changes on production

### Deployment Notes
- The deploy webhook may show "0 seconds" build time — this can mean it restarted without rebuilding. Use the Easypanel UI "Deploy" button to force a full rebuild if needed.
- The Dockerfile correctly copies `public/` into the image (line 41). If static files aren't updating, the Docker image needs a no-cache rebuild.
- **Browser cache is the most common reason changes don't appear** after a successful deploy. The container may have the correct files (verify via Easypanel Service Console: `ls -la /app/public/` or `grep "someNewFunction" /app/public/suggest.html`).

---

## Troubleshooting

### Voice Messages Not Transcribing
1. Check OPENAI_API_KEY is set in environment variables
2. Check Easypanel logs for "Starting audio transcription with Whisper"
3. Verify attachment URL is accessible

### Image Analysis Not Working
1. Check ANTHROPIC_API_KEY is set
2. Check logs for "Starting image analysis"
3. Verify image URL is accessible from Chatwoot

### Wrong Language Response
1. Whisper now auto-detects language (no hints passed)
2. Language is re-detected on every voice message
3. Check user's language in database if persisting issues

### Webhook Not Reaching API
1. Verify Chatwoot webhook URL is `https://carelog.vivebien.io/ingest/chatwoot`
2. Do NOT use `vivebien-core-api.srv818872.hstgr.cloud` (SSL issues)
3. Check "Message created" event is selected in Chatwoot
4. Check Easypanel logs for "Received Chatwoot webhook"

### WhatsApp Bold Not Working
1. Check postProcess() isn't stripping asterisks
2. Verify AI prompt includes `*bold*` in format template
3. Test with: `*test*` should render bold in WhatsApp

### Landing Page Issues
| Issue | Solution |
|-------|----------|
| Logo not loading | Check `/:userId` route skips file extensions. Verify Logo1.png exists in public/ |
| Wrong language | Verify user.language in DB, check API returns it |
| Name shows "Usuario" | User didn't provide name |
| No summary | Check memories table has health_summary for user |

---

## n8n Workflows (Available via MCP)

| Workflow | ID | Purpose |
|----------|----|---------|
| **SQL_Runner** | **rWG8DN8q_HT9q6EZ_wFel** | **Direct PostgreSQL queries — USE THIS for all DB operations** |
| Claude_DevOps_Gateway_v3 | dEoR_KiQ2LQYAE7Q9Jv9E | Database queries, health check, context |
| Claude_GitHub_Deploy | X_HtoNPd4J1RpmkShMgqi | Push files to GitHub + trigger deploy |
| CareLog_Claude Database Access | AofV_qusW1Vz9XZQtIksN | Direct database queries |
| CareLog_Claude_FileManager_HTTP_v2 | Jq8tlq176ilHzJsDLyRuv | Google Drive file operations |

### Direct Database Access via psql (Preferred)
```bash
/opt/homebrew/opt/libpq/bin/psql "postgres://postgres:bd894cefacb1c52998f3@85.209.95.19:5432/projecto-1" -c "SELECT * FROM users LIMIT 5"
```
- **psql path**: `/opt/homebrew/opt/libpq/bin/psql`
- **Connection**: `postgres://postgres:bd894cefacb1c52998f3@85.209.95.19:5432/projecto-1`
- Supports multi-statement queries, faster than n8n

### n8n SQL_Runner (Backup)
```json
{
  "type": "webhook",
  "webhookData": {
    "body": {
      "query": "SELECT * FROM users LIMIT 5"
    }
  }
}
```
Workflow ID: `rWG8DN8q_HT9q6EZ_wFel`. **Run one query per call** — multiple statements will fail.

---

## GitHub Push Access (for Claude)

At the start of each session, configure git to push directly:

```bash
TOKEN=$(cat .github-token)
git remote set-url origin https://jmariano19:${TOKEN}@github.com/jmariano19/vivebien-core.git
```

The token is stored in `.github-token` (gitignored, never committed). After configuring, Claude can push and deploy with:

```bash
git push && curl -s http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22 && curl -s http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548
```

---

## Notes
- **Product name**: "CareLog" (AI tool for health documentation)
- **Domain**: carelog.vivebien.io
- **GitHub**: https://github.com/jmariano19/vivebien-core
- **Figma**: https://figma.com/design/UgbafTWqp5i0sMZgT9GMrE
- **n8n**: Used for database access via SQL_Runner workflow (ID: `rWG8DN8q_HT9q6EZ_wFel`). Not required for core messaging.
- **Database access**: Use `psql` directly (preferred): `/opt/homebrew/opt/libpq/bin/psql "postgres://postgres:bd894cefacb1c52998f3@85.209.95.19:5432/projecto-1"`. Backup: n8n SQL_Runner via MCP (one query per call).
- **Deleting test users**: Use `DELETE /api/test/user` endpoint (preferred — handles all child tables automatically), or use SQL_Runner to delete from all child tables first (messages, health_concerns, memories, conversation_state, experiment_assignments, credit_transactions, billing_accounts), then delete from users. See Testing section for full procedure.
- **Pressure testing**: Say "pressure test the system" and Claude will automatically run the test endpoint with various multilingual scenarios, analyze results, fix issues, and redeploy. See Automated Pressure Test System section.
- System prompt is in `conversation/service.ts` `getDefaultSystemPrompt()` — containment-first philosophy with 7 design principles
- AI does NOT ask for user's name — the system sends it as a separate delayed message after summary delivery
- Summary delivery is split into 3 messages: ack (immediate) → note (10s) → name ask (5s)
- If summary link doesn't appear, check BOTH services are deployed
- **Fonts**: Only Outfit + Lora (design system requirement)
- **Valid concern statuses**: `active`, `improving`, `resolved` only
- **AI Models**: Opus 4.5 (conversations), Sonnet 4.5 (summaries), Haiku 4.5 (concern detection)
