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
- ✅ AI responses with Claude
- ✅ Summary generation in chat
- ✅ Summary link after summaries: 📋 Ver mi resumen 👇 + URL
- ✅ Landing page at carelog.vivebien.io/{userId}
- ✅ Multi-language support (es, en, pt, fr)

### Recent Changes:
1. Removed duplicate link instructions from AI prompt
2. Link only on summary messages (looksLikeSummary detection)
3. Format: 📋 Ver mi resumen 👇 + URL on new line
4. URL: https://carelog.vivebien.io/{userId}

## Testing

### Test Phone: +12017370113

### Clear Test Data:
```sql
DELETE FROM users WHERE phone IN ('+12017370113', '2017370113');
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

## Notes
- If summary link doesn't appear, check BOTH services are deployed
- If landing page shows "No summary yet", memories table may not have data
- System prompt is in conversation/service.ts, not a file
- AI assistant name: "Confianza"
- GitHub: https://github.com/jmariano19/vivebien-core
