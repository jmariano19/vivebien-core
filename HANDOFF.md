# ViveBien Core - Project Handoff

## Project Overview
**ViveBien Core** is a scalable backend service for a WhatsApp-based wellness platform. Users chat via WhatsApp to log health symptoms, and the AI assistant (named "Confianza") helps them prepare summaries for doctor visits.

## Architecture
```
WhatsApp → Chatwoot → n8n (thin relay) → vivebien-core API → BullMQ → Workers → Claude AI
                                                ↓
                                          PostgreSQL + Redis
```

### Flow:
1. User sends WhatsApp message
2. Chatwoot receives it, triggers webhook to n8n
3. n8n forwards to vivebien-core-api at /ingest/chatwoot
4. API queues job to BullMQ (Redis)
5. vivebien-core-worker picks up job, processes with Claude AI
6. Worker sends response back via Chatwoot API
7. Summary is saved to memories table for landing page

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript
- **Framework**: Fastify
- **Queue**: BullMQ (Redis)
- **Database**: PostgreSQL 16+
- **Cache**: Redis 7+
- **AI**: Anthropic Claude API
- **Messaging**: Chatwoot (WhatsApp integration)
- **Automation**: n8n (webhook relay)

## Infrastructure

### Easypanel Services (projecto-1)
| Service | Purpose |
|---------|---------|
| vivebien-core-api | API server, receives webhooks, serves landing page |
| vivebien-core-worker | Processes messages, calls AI, sends responses |
| vivebien-staging | Staging environment |
| zep | Memory service (optional) |

**⚠️ IMPORTANT**: When deploying code changes, you must deploy BOTH vivebien-core-api AND vivebien-core-worker!

### Database (PostgreSQL)
- **Host**: 85.209.95.19:5432
- **Database**: projecto-1
- **User**: postgres
- **Password**: bd894cefacb1c52998f3

### Key Tables
| Table | Purpose |
|-------|---------|
| users | User records (id, phone, language, name) |
| messages | Conversation history |
| memories | Health summaries (category='health_summary') |
| conversation_state | Current phase, message count |

## Repository Structure
```
vivebien-project/
├── src/
│   ├── index.ts                 # API server entry point + page routes
│   ├── api/routes/
│   │   ├── ingest.ts            # Webhook endpoint (/ingest/chatwoot)
│   │   ├── summary.ts           # Summary API (GET & PUT /api/summary/:userId)
│   │   ├── doctor.ts            # Doctor API (/api/doctor/:userId)
│   │   └── health.ts            # Health check
│   ├── domain/
│   │   ├── ai/service.ts        # AI service, postProcess(), summary link logic
│   │   ├── conversation/service.ts  # System prompts, updateHealthSummary()
│   │   └── user/service.ts      # User CRUD
│   ├── worker/
│   │   ├── index.ts             # Worker entry point
│   │   └── handlers/inbound.ts  # Main message handler
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

## Key Code Locations

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

### Edit Summary Page
- **URL**: https://carelog.vivebien.io/suggest/{userId}
- **HTML**: public/suggest.html
- **API**: PUT /api/summary/:userId (to save changes)
- **Features**:
  - Structured form with 8 health fields
  - Medication chips with add/remove functionality
  - Change indicators showing modified fields
  - Multi-language support

### Summary API Endpoints (src/api/routes/summary.ts)
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/summary/:userId | Get user's health summary |
| PUT | /api/summary/:userId | Update/create health summary |
| GET | /api/summary/user/:phone | Get summary by phone number |

### Doctor View Page (NEW)
- **URL**: https://carelog.vivebien.io/doctor/{userId}
- **HTML**: public/doctor.html
- **API**: /api/doctor/:userId
- **Purpose**: Clinically-formatted, doctor-ready handoff document

**User Flow:**
1. Patient views summary at `/{userId}`
2. Taps "Version para tu Doctor" CTA button
3. Navigates to `/doctor/{userId}`
4. Sees structured clinical note with sections:
   - Motivo de consulta (Chief Complaint)
   - Historia del problema actual (HPI)
   - Síntomas asociados
   - Medidas realizadas
   - Preguntas/objetivos para la consulta

**Template Rules (Non-negotiable):**
- Exactly ONE HPI section
- No patient-chat tone or emojis in content
- No medical advice, diagnosis, or prognosis
- "Síntomas asociados" always present (shows "No reportados" if empty)
- "Preguntas/objetivos" expresses intent, never repeats symptoms
- Missing data: omit line OR use "No reportados"
- Always includes footer disclaimer

**Features:**
- Font size controls (A+ button)
- Share button (Web Share API or clipboard fallback)
- Download/print button
- Mobile-first, printable layout
- Multi-language support (es, en, pt, fr)

## CareLog Onboarding Flow

### Core Principle
**Trust is earned through usefulness BEFORE explanation.**

The AI identity is disclosed clearly and honestly — but ONLY AFTER the user has experienced value (a generated health summary). Never introduce the AI identity in the very first message.

### Flow Sequence (5 Steps)

| Step | Trigger | What Happens |
|------|---------|--------------|
| **1. First Contact** | User sends first message ("hi", "hola", anything) | Greeting + value prop. NO AI mention. NO disclaimers. NO name request. |
| **2. Intake** | After user shares concern | Ask 1 question at a time: when started, location, what helps/worsens |
| **3. Summary** | Enough info collected | Generate doctor-ready summary. This is the VALUE MOMENT. |
| **4. AI Disclosure** | After summary delivered | "Just to be clear — I'm an AI tool, not a doctor." |
| **5. Name Request** | After AI disclosure | "What name would you like me to use? (Totally optional.)" |

### First Contact Message (No AI)
```
Good morning 👋
I help you turn what's been happening with your health into a clear note you can share with your doctor.
What's been going on lately?
```

### Post-Summary Message
```
I've put this into a clear health note for you.
It's now saved, so you don't have to rely on memory if this changes or if you see a doctor later.
```

### AI Disclosure Message
```
Just to be clear — I'm an AI tool, not a doctor.
I don't replace medical care. I help you prepare for it by organizing what you share into a clear record.
```

### Key Files
- `src/domain/conversation/service.ts` - System prompt with full onboarding flow
- Templates: `onboarding_greeting`, `summary_delivered`, `ai_disclosure`, `ask_name`

### Behavioral Guardrails
- Never imply you are human
- Never imply you are a clinician
- Never provide diagnosis or treatment recommendations
- Never lead with "I'm an AI"
- Let usefulness establish trust first

---

## Current State (Feb 3, 2026)

### Working:
- ✅ WhatsApp conversations via Chatwoot
- ✅ AI responses with Claude (Opus 4.5 for conversations, Sonnet for summaries)
- ✅ CareLog onboarding flow (value-first, AI disclosure after summary)
- ✅ Summary generation in chat with WhatsApp formatting
- ✅ Summary link after summaries (localized): 📋 View my summary 👇 + URL
- ✅ Landing page at carelog.vivebien.io/{userId}
- ✅ Doctor view page at carelog.vivebien.io/doctor/{userId}
- ✅ Appointment preparation page at carelog.vivebien.io/appointment/{userId}
- ✅ Edit Summary page at carelog.vivebien.io/suggest/{userId}
- ✅ View History page at carelog.vivebien.io/history/{userId}
- ✅ Multi-language support (es, en, pt, fr)
- ✅ Language auto-detection from user messages
- ✅ Name extraction from conversations (including proactive name sharing)
- ✅ WhatsApp bold formatting (*text*)
- ✅ Static file serving (logo, assets)
- ✅ One-command deployment via webhook triggers
- ✅ Summary sync/update via PUT /api/summary/:userId

### Recent Changes (Feb 3, 2026 - Evening):

#### AI Identity Update - "Constanza"
- Changed AI name from "Confianza" to "Constanza"
- New transparent intro message:
  ```
  Hola 👋 Soy Constanza, tu agente de IA.
  Te ayudo a documentar lo que te pasa y organizarlo en una nota clara para tu próxima consulta.
  No reemplazo médicos — te ayudo a llegar mejor preparado.
  ¿Qué te gustaría registrar hoy?
  ```
- Updated system prompt for transparent AI approach
- Files changed: `src/domain/conversation/service.ts`, `src/domain/ai/service.ts`

#### Simplified Summary Format
- Changed from complex headers (MOTIVO PRINCIPAL, PATRÓN/SEVERIDAD) to simple labels
- New format: `Motivo:`, `Inicio:`, `Mejora con:`, `Empeora con:`, `Medicamentos:`
- Max 5 lines, cleaner and more readable
- File: `src/domain/ai/service.ts` (generateSummary function)

#### Optimization & Scalability Work
- Created `/public/js/carelog-utils.js` - shared utilities for all pages
- Created `/migrations/002_optimization_indexes.sql` - database indexes
- Created `/OPTIMIZATION_REPORT.md` - detailed optimization documentation

**Database Indexes Added:**
- `idx_users_phone` (UNIQUE) - Critical for phone lookups
- `idx_messages_user_created` - Conversation history
- `idx_memories_user_category_created` - Summary retrieval
- Foreign key constraints for data integrity

**Run migration:**
```bash
psql $DATABASE_URL < migrations/002_optimization_indexes.sql
```

#### Display Bug Fixes
- Fixed "no proporcionado is helping" display bug
- Fixed History page showing raw markdown (`**MOTIVO PRINCIPAL**`)
- Added comprehensive header cleaning across all pages
- Files: `summary.html`, `history.html`, `suggest.html`

#### QA Documentation
- Created `/QA_CHECKLIST.md` - Testing guide for Claude QA
- Created `/SYNC_ANALYSIS.md` - Data sync flow documentation

---

### Recent Changes (Feb 3, 2026 - Earlier):

#### New Pages Added

**Edit Summary Page** (`/suggest/:userId`)
- **HTML**: `public/suggest.html`
- **Purpose**: Allows users to edit their health summary with structured form fields
- **Features**:
  - Structured fields: Main Concern, Onset, Location, Symptoms, What Helps, What Worsens, Medications, Notes
  - Medications field with interactive chips (add with + button, remove with ×)
  - Change indicators (green dots) showing which fields were modified
  - Multi-language support (es, en, pt, fr)
  - Saves to database via PUT /api/summary/:userId

**View History Page** (`/history/:userId`)
- **HTML**: `public/history.html`
- **Purpose**: Timeline view of user's health history

**Appointment Page** (`/appointment/:userId`)
- **HTML**: `public/appointment.html`
- **Purpose**: Help users prepare for doctor appointments

#### PUT Endpoint for Summary Sync (src/api/routes/summary.ts)
```typescript
app.put('/:userId', async (request, reply) => {
  // Updates or creates health_summary in memories table
  // Body: { summary: string }
  // Returns: { success: true, message: string, updatedAt: string }
});
```

#### Sticky Headers
- All pages now have sticky headers (position: sticky, top: 0, z-index: 100)

#### CareLog Logo Font
- Changed from "Outfit" to "Malayalam MN" across all pages

#### Static File Routing Fix (src/index.ts)
- **Root cause**: The `/:userId` catch-all route was intercepting static file requests (like `/Logo1.png`) and returning 404
- **Fix**: Added check to skip requests with file extensions, passing them to the static file handler
```typescript
if (userId.includes('.')) {
  return reply.callNotFound();
}
```

#### Landing Page Summary Display (public/summary.html)
- Rewrote `cleanSummaryForDisplay()` to handle single-line format with `---` separators
- Removes all structured headers (MOTIVO PRINCIPAL, INICIO, PATRÓN, etc.)
- Removes field labels and disclaimers
- Strips WhatsApp `*asterisk*` formatting for clean web display

#### Proactive Name Extraction (src/worker/handlers/inbound.ts)
- Now detects when users introduce themselves without being asked
- Patterns: "mi nombre es X", "my name is X", "me llamo X", etc.
- Works in any conversation phase, not just when AI asks

#### Logo Update
- Logo file renamed to `Logo1.png`
- Reference: `<img src="/Logo1.png" alt="CareLog" onerror="this.onerror=null; this.src='/logo.svg';">`

### Previous Changes (Feb 2, 2026):

#### WhatsApp Formatting
- Fixed postProcess() to preserve WhatsApp bold (`*text*`) and italic (`_text_`)
- Added format template with `📝 *Health Summary*`, `❓ *Questions for your visit*`, `*Would you like to:*`
- Converts markdown `**bold**` to WhatsApp `*bold*`

#### Language Detection
- Improved English detection with expanded word list (50+ common words)
- Counts individual word matches for better accuracy with short messages
- Handles phrases like "I have a sty on my eye" correctly
- Falls back to English for ties with high scores

#### Summary Generation
- Summaries preserve user's original words (no translation of symptoms)
- Only section headers are translated to user's language
- Doctor-ready format with structured sections

### 24-Hour Check-in Feature (NEW)

Automated follow-up 24 hours after a user receives their first summary. Purpose: retention through calm continuity.

**Files:**
- `src/domain/checkin/service.ts` - Main check-in logic, templates, scheduling
- `src/worker/handlers/checkin.ts` - Job handler and response processing
- `src/worker/checkin-processor.ts` - BullMQ job processor
- `migrations/001_add_checkin_fields.sql` - Database migration

**How it works:**
1. After sending a summary (detected by `carelog.vivebien.io` link), a check-in is scheduled for +24h
2. When the job fires, it checks if user has been inactive since the summary
3. If inactive, sends a personalized check-in message
4. User's response updates the health summary with a follow-up entry

**State fields in conversation_state:**
| Field | Purpose |
|-------|---------|
| checkin_status | 'not_scheduled', 'scheduled', 'sent', 'canceled', 'completed' |
| checkin_scheduled_for | Timestamp when check-in should fire |
| last_summary_created_at | When last summary was generated |
| last_user_message_at | For inactivity detection |
| last_bot_message_at | For active conversation detection |
| case_label | e.g., "your eye" for personalized message |

**Cancellation conditions:**
- User sent ANY message after summary
- Active conversation in last 6 hours
- New summary created (reschedules)

**Message templates (in CheckinService):**
```
Hi {name} 👋
Just checking in.
How is {case_label} feeling today compared to yesterday?
If anything has changed, I can add it to your note.
```

**Before deploying:** Run the migration:
```sql
-- See migrations/001_add_checkin_fields.sql
```

### Known Issues:
- Need to deploy BOTH api and worker services after changes (use `deploy` command)

## Testing

### Test Phone: +12017370113

### Clear Test Data (via n8n):
Use the CareLog_Claude Database Access workflow (ID: `AofV_qusW1Vz9XZQtIksN`) to clear test data.

**Execute these queries in order:**
```sql
-- 1. Delete messages
DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 2. Delete memories
DELETE FROM memories WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 3. Delete conversation state
DELETE FROM conversation_state WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 4. Delete billing accounts
DELETE FROM billing_accounts WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'));

-- 5. Delete user (run last)
DELETE FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113') RETURNING phone;
```

**MCP Execute Format:**
```json
{
  "workflowId": "AofV_qusW1Vz9XZQtIksN",
  "inputs": {
    "type": "webhook",
    "webhookData": {
      "body": {
        "sql": "DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE phone IN ('+12017370113', '12017370113', '2017370113'))"
      }
    }
  }
}
```

### Quick Summary: Say "dame mi resumen" or "ver resumen"

## Deployment

### ⚠️ IMPORTANT: Deploying Changes to Production

**BOTH services must be deployed after ANY code change!** The API and Worker share the same codebase but run as separate services.

### Quick Deploy (Copy & Paste)

**Step 1: Commit and push changes**
```bash
cd ~/Desktop/vivebien-project && git add -A && git commit -m "Your commit message" && git push
```

**Step 2: Trigger both deployments**
```bash
curl -X POST "http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22" && curl -X POST "http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548"
```

### One-Command Deploy Function (Recommended)

Add this function to your `~/.zshrc` or `~/.bashrc`:

```bash
deploy() {
  cd ~/Desktop/vivebien-project && \
  git add -A && \
  git commit -m "${1:-Update}" && \
  git push && \
  echo "🚀 Deploying API..." && \
  curl -s "http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22" && \
  echo "🚀 Deploying Worker..." && \
  curl -s "http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548" && \
  echo "✅ Done! Both services deploying."
}
```

Then reload: `source ~/.zshrc`

**Usage:**
```bash
deploy "Your commit message here"
```

### Deployment Webhook URLs (Easypanel)

| Service | Webhook URL | Must Deploy |
|---------|-------------|-------------|
| vivebien-core-api | `http://85.209.95.19:3000/api/deploy/1642a4c845b117889b4b6cbe0172ecc90b03500666da6e22` | ✅ Always |
| vivebien-core-worker | `http://85.209.95.19:3000/api/deploy/27730fe51447b7b37aad06851ccb0470e5b62421badd9548` | ✅ Always |

### Manual Deployment (via Easypanel UI)

1. Commit and push:
```bash
cd ~/Desktop/vivebien-project
git add -A && git commit -m "message" && git push
```

2. Go to Easypanel (https://85.209.95.19:3000)
3. Deploy BOTH services:
   - vivebien-core-api → Click Deploy
   - vivebien-core-worker → Click Deploy

### Deployment Checklist

After making changes:
- [ ] Commit changes to git
- [ ] Push to GitHub
- [ ] Trigger API webhook OR click Deploy in Easypanel
- [ ] Trigger Worker webhook OR click Deploy in Easypanel
- [ ] Wait ~30 seconds for builds to complete
- [ ] Test the changes on production

## n8n Workflows

### Claude DevOps Gateway (Claude_DevOps_Gateway_v3)
Direct database and project access for Claude assistants.

**Webhook URL**: `https://projecto-1-n8n.yydhsb.easypanel.host/webhook/claude-devops`

**Available Tools:**

| Tool | Description | Example |
|------|-------------|---------|
| `database` | Execute raw SQL queries | `{ "tool": "database", "query": "SELECT * FROM users LIMIT 5" }` |
| `get_context` | Get project status, priorities, stats | `{ "tool": "get_context" }` |
| `health_check` | Check gateway status | `{ "tool": "health_check" }` |

**Usage (via MCP):**
```javascript
// Execute workflow with tool and query
{
  "tool": "database",
  "query": "UPDATE users SET language = 'pt' WHERE id = 'user-uuid'"
}
```

**get_context returns:**
- Project version, phase, status
- Current focus area and next steps
- Health metrics (active users, credits, errors)
- Top 5 pending optimizations
- Known issues and recent changes

### CareLog Claude Database Access
Alternative database access workflow for summary queries.

**Workflow ID**: `AofV_qusW1Vz9XZQtIksN`

### ViveBien DevOps Workflow Updater
Allows updating n8n workflows programmatically.

**Workflow ID**: `KuemMBFSQcwHyBkXAP50R`

## Key Functions Reference

### Language Detection (src/worker/handlers/inbound.ts)
```typescript
detectLanguage(message: string): 'es' | 'en' | 'pt' | 'fr' | null
```
- Counts word matches for each language
- Requires 2+ matches for confidence
- Returns null if no clear winner

### Name Extraction (src/worker/handlers/inbound.ts)
```typescript
extractUserName(userMessage: string, recentMessages: Message[]): string | null
```
- **Proactive detection**: Extracts name when user says "mi nombre es X", "my name is X", etc.
- **Reactive detection**: Checks if previous AI message asked for name
- Validates name (1-4 words, 2-20 chars each, letters only)
- Supports es, en, pt, fr languages

### Post-Processing (src/domain/ai/service.ts)
```typescript
postProcess(content: string, userId?: string, language?: string): string
```
- Converts `**markdown**` to `*WhatsApp*` bold
- Preserves `*text*` and `_text_` formatting
- Adds summary link if looksLikeSummary() returns true
- Truncates to 4000 chars (WhatsApp limit)

### Summary Generation (src/domain/ai/service.ts)
```typescript
generateSummary(messages: Message[], currentSummary: string | null, language?: string): Promise<string>
```
- Uses Claude Sonnet for cost efficiency
- Generates doctor-ready format with localized headers
- Preserves user's original symptom descriptions

## Troubleshooting

### WhatsApp Bold Not Working
1. Check postProcess() isn't stripping asterisks
2. Verify AI prompt includes `*bold*` in format template
3. Test with: `*test*` should render bold in WhatsApp

### Landing Page Issues
| Issue | Solution |
|-------|----------|
| Logo not loading | Check `/:userId` route skips file extensions (see static file routing fix). Verify Logo1.png exists in public/ |
| Wrong language | Verify user.language in DB, check API returns it |
| Name shows "Usuario" | Check name extraction patterns match AI's question, or user didn't provide name proactively |
| No summary | Check memories table has health_summary for user |
| Summary shows raw structured data | Check `cleanSummaryForDisplay()` in summary.html handles the format |

### Language Detection Not Working
1. Check user message has 2+ matching words
2. For English: verify common words like "I", "have", "the", "my" are in message
3. Check detectLanguage() return value in logs

### Summary Link Not Appearing
1. Check looksLikeSummary() indicators match response
2. Verify userId is passed to postProcess()
3. Check response doesn't already contain carelog.vivebien.io

## Environment Variables

| Variable | Description |
|----------|-------------|
| ANTHROPIC_API_KEY | Claude API key |
| DATABASE_URL | PostgreSQL connection string |
| REDIS_URL | Redis connection string |
| CHATWOOT_API_KEY | Chatwoot API token |
| CHATWOOT_BASE_URL | Chatwoot instance URL |
| PORT | API server port (default: 3000) |

## Notes
- If summary link doesn't appear, check BOTH services are deployed
- If landing page shows "No summary yet", memories table may not have data
- System prompt is in conversation/service.ts, not a file
- Product name: "CareLog" (AI tool for health documentation)
- GitHub: https://github.com/jmariano19/vivebien-core
