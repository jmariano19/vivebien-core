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
│   ├── index.ts                 # API server entry point
│   ├── api/routes/
│   │   ├── ingest.ts            # Webhook endpoint (/ingest/chatwoot)
│   │   ├── summary.ts           # Summary API (/api/summary/:userId)
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
│   └── summary.html             # Landing page (carelog.vivebien.io/{userId})
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

### Landing Page
- **URL**: https://carelog.vivebien.io/{userId}
- **HTML**: public/summary.html
- **API**: /api/summary/:userId
- **Data**: memories table where category = 'health_summary'

## Current State (Feb 2, 2026)

### Working:
- ✅ WhatsApp conversations via Chatwoot
- ✅ AI responses with Claude (Opus 4.5 for conversations, Sonnet for summaries)
- ✅ Summary generation in chat with WhatsApp formatting
- ✅ Summary link after summaries (localized): 📋 View my summary 👇 + URL
- ✅ Landing page at carelog.vivebien.io/{userId}
- ✅ Multi-language support (es, en, pt, fr)
- ✅ Language auto-detection from user messages
- ✅ Name extraction from conversations
- ✅ WhatsApp bold formatting (*text*)

### Recent Changes (Feb 2, 2026):

#### WhatsApp Formatting
- Fixed postProcess() to preserve WhatsApp bold (`*text*`) and italic (`_text_`)
- Added format template with `📝 *Health Summary*`, `❓ *Questions for your visit*`, `*Would you like to:*`
- Converts markdown `**bold**` to WhatsApp `*bold*`

#### Language Detection
- Improved English detection with expanded word list (50+ common words)
- Counts individual word matches for better accuracy with short messages
- Handles phrases like "I have a sty on my eye" correctly
- Falls back to English for ties with high scores

#### Name Extraction
- Added pattern: "what name would you like me to use for you"
- Removed onboarding phase restriction (works in any conversation phase)
- Patterns support es, en, pt, fr languages

#### Summary Generation
- Summaries preserve user's original words (no translation of symptoms)
- Only section headers are translated to user's language
- Doctor-ready format with structured sections

#### Landing Page (public/summary.html)
- Multi-language localization (i18n object)
- Logo with SVG fallback: `<img src="/Logo.png" onerror="this.src='/logo.svg'">`
- User name display from API
- Live updates badge
- Clean summary display (removes structured data headers)

### Known Issues:
- Logo may not load on some deployments (SVG fallback works)
- Need to deploy BOTH api and worker services after changes

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

```bash
cd ~/Desktop/vivebien-project
git add -A && git commit -m "message" && git push
```

Then in Easypanel deploy BOTH:
1. vivebien-core-api → Deploy
2. vivebien-core-worker → Deploy

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
- Checks if previous AI message asked for name
- Validates name (1-4 words, 2-20 chars each, letters only)
- Handles prefixes like "my name is", "me llamo", etc.

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
| Logo not loading | Check Logo.png exists in public/, SVG fallback should work |
| Wrong language | Verify user.language in DB, check API returns it |
| Name shows "Usuario" | Check name extraction patterns match AI's question |
| No summary | Check memories table has health_summary for user |

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
- AI assistant name: "Confianza"
- GitHub: https://github.com/jmariano19/vivebien-core
