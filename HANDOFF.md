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
│   │   └── health.ts            # Health check
│   ├── domain/
│   │   ├── ai/service.ts        # AI service, postProcess(), summary link, detectConcernTitle()
│   │   ├── concern/service.ts   # ConcernService (multi-concern CRUD + snapshots)
│   │   ├── conversation/service.ts  # System prompts, updateHealthSummary() (multi-concern)
│   │   ├── media/service.ts     # Voice transcription (Whisper) + Image analysis (Vision)
│   │   └── user/service.ts      # User CRUD
│   ├── worker/
│   │   ├── index.ts             # Worker entry point
│   │   └── handlers/inbound.ts  # Main message handler (processes attachments)
│   └── adapters/chatwoot/client.ts  # Chatwoot API client
├── public/
│   ├── index.html               # Admin dashboard
│   ├── summary.html             # Landing page (/{userId})
│   ├── doctor.html              # Doctor view (/doctor/{userId})
│   ├── appointment.html         # Appointment prep (/appointment/{userId})
│   ├── suggest.html             # Edit summary (/suggest/{userId})
│   └── history.html             # View history (/history/{userId})
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

### Frontend Pages (Updated)
- **summary.html** — Shows multiple concern cards with status badges, tap to expand
- **history.html** — Concern tabs + snapshot timeline, status change modal, delete flow
- **suggest.html** — Accepts `?concernId=X&returnTo=history` for per-concern editing
- **doctor.html** — Renders each concern as a separate clinical section

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

## n8n Deprecation Notice

**As of Feb 5, 2026, n8n is NO LONGER required for CareLog.**

### What n8n Was Used For (Previously)
- ❌ Chatwoot webhook relay → Now handled by `/ingest/chatwoot` endpoint
- ❌ Database access → Now handled by `src/infra/db/client.ts`
- ❌ Voice transcription → Now handled by MediaService (Whisper)
- ❌ Image analysis → Now handled by MediaService (Claude Vision)

### What Still Works Without n8n
| Function | Status | Implementation |
|----------|--------|----------------|
| Chatwoot Webhooks | ✅ Direct | `/ingest/chatwoot` endpoint |
| Database Access | ✅ Direct | PostgreSQL via pg module |
| Voice Transcription | ✅ Direct | OpenAI Whisper API |
| Image Analysis | ✅ Direct | Claude Vision API |
| Send Responses | ✅ Direct | ChatwootClient |
| 24h Check-ins | ✅ Direct | BullMQ scheduler |
| Message Queue | ✅ Direct | Redis + BullMQ |

### n8n Workflows (Can Be Disabled)
These workflows are no longer needed but may still exist:
- Chatwoot Webhook relay
- Claude DevOps Gateway (optional, for database queries only)

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
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
  - `detectLanguage()` - Language detection from text
  - `extractUserName()` - Name extraction from messages

### Webhook Endpoint
- **File**: `src/api/routes/ingest.ts`
- **Endpoint**: `POST /ingest/chatwoot`
- **Also supports**: `POST /api/ingest` (backwards compatibility)

### Summary Link Feature
Link appears after AI generates a summary in WhatsApp.

**Files:**
1. src/domain/ai/service.ts
   - postProcess() - Cleans AI response, adds summary link
   - looksLikeSummary() - Detects if response is a summary
   - getSummaryLinkText() - Returns localized link text

2. src/domain/conversation/service.ts
   - buildSystemPrompt() - Builds AI system prompt
   - updateHealthSummary() - Saves summary to memories table

3. src/worker/handlers/inbound.ts
   - Main handler: load user → call AI → postProcess → send response

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

## Current State (Feb 5, 2026)

### Working:
- ✅ WhatsApp conversations via Chatwoot (direct, no n8n)
- ✅ Voice message transcription (OpenAI Whisper with auto language detection)
- ✅ Image analysis (Claude Vision)
- ✅ AI responses with Claude (Opus 4.5 for conversations, Sonnet for summaries)
- ✅ CareLog onboarding flow (value-first, AI disclosure after summary)
- ✅ Summary generation in chat with WhatsApp formatting
- ✅ Summary link after summaries (localized): 📋 View my summary 👇 + URL
- ✅ Landing page at carelog.vivebien.io/{userId} (multi-concern cards)
- ✅ Doctor view page at carelog.vivebien.io/doctor/{userId} (multi-concern clinical sections)
- ✅ Appointment preparation page at carelog.vivebien.io/appointment/{userId}
- ✅ Edit Summary page at carelog.vivebien.io/suggest/{userId} (per-concern editing)
- ✅ View History page at carelog.vivebien.io/history/{userId} (concern tabs + snapshot timeline)
- ✅ Multi-concern health tracking with status lifecycle (active → improving → resolved)
- ✅ Concern change history with snapshots (auto_update, user_edit, status_change)
- ✅ Concerns API (/api/concerns/:userId) with full CRUD
- ✅ Multi-language support (es, en, pt, fr)
- ✅ Language auto-detection from user messages AND voice
- ✅ Name extraction from conversations (including proactive name sharing)
- ✅ WhatsApp bold formatting (*text*)
- ✅ 24-hour check-in feature
- ✅ Direct database access (no n8n required)

### Recent Changes (Feb 5, 2026):

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

### Clear Test Data (via Database):
```sql
-- 1. Delete concern snapshots (cascades from health_concerns, but explicit is safer)
DELETE FROM concern_snapshots WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 2. Delete health concerns
DELETE FROM health_concerns WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 3. Delete messages
DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 4. Delete memories
DELETE FROM memories WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 5. Delete conversation state
DELETE FROM conversation_state WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 6. Delete billing accounts
DELETE FROM billing_accounts WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 7. Delete user (run last)
DELETE FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113') RETURNING phone;
```

### Test Scenarios:
1. **Text message**: Send "Hello" → Should respond in English
2. **Voice message in English**: Record "I have pain in my left eye" → Should transcribe and respond in English
3. **Voice message in Spanish**: Record "Tengo dolor de cabeza" → Should transcribe and respond in Spanish
4. **Image**: Send photo of medication → Should analyze and describe

---

## Deployment

### ⚠️ IMPORTANT: Deploying Changes to Production

**BOTH services must be deployed after ANY code change!** The API and Worker share the same codebase but run as separate services.

### Quick Deploy (Single Command)

```bash
cd ~/Desktop/vivebien-project && git push && curl -s http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22 && curl -s http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548
```

This pushes to GitHub and triggers both API + Worker deployments in one go.

### Deployment Checklist

After making changes:
- [ ] Commit changes to git
- [ ] Push to GitHub
- [ ] Deploy API service in Easypanel
- [ ] Deploy Worker service in Easypanel
- [ ] Wait ~30 seconds for builds to complete
- [ ] Test the changes on production

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

## Notes
- **Product name**: "CareLog" (AI tool for health documentation)
- **Domain**: carelog.vivebien.io
- **GitHub**: https://github.com/jmariano19/vivebien-core
- **n8n**: No longer required for core functionality, but Claude_DevOps_Gateway_v3 workflow is available for database queries via MCP
- System prompt is in conversation/service.ts, not a separate file
- If summary link doesn't appear, check BOTH services are deployed
