# Claude Code Working Context

## Project Overview
**ViveBien** - WhatsApp wellness platform using Fastify API + BullMQ workers deployed on Easypanel.

### Architecture
```
WhatsApp → Chatwoot → n8n (thin relay) → Fastify API → BullMQ/Redis → Worker → Claude AI → Chatwoot → WhatsApp
```

---

## GitHub Access
- **Repo**: jmariano19/vivebien-core
- **Token**: (provide token at start of session - stored in password manager)
- **Access**: Read & Write (verified working)
- **Branch**: main

---

## Database Access (via n8n)
- **Workflow Name**: Claude Database Access
- **Workflow ID**: AofV_qusW1Vz9XZQtIksN
- **Usage**: Execute SQL queries directly
- **Endpoint**: POST to /webhook/claude-db with `{ "sql": "YOUR_QUERY" }`

---

## Deployment
- **Platform**: Easypanel (Docker Swarm)
- **Server IP**: 85.209.95.19
- **Auto-deploy**: Manual trigger required (click Deploy button in Easypanel)

## Services
| Service | Internal IP | Port | Status |
|---------|-------------|------|--------|
| vivebien-core-api | 10.0.1.8 | 3000 | ✅ Running |
| vivebien-core-worker | (same swarm) | - | ✅ Running |
| n8n | 10.0.1.2 | - | ✅ Running |
| Redis | projecto-1_redis | 6379 | ✅ Running |
| PostgreSQL | projecto-1_postgress | 5432 | ✅ Running |

---

## n8n Workflows
| Workflow | Purpose |
|----------|---------|
| ViveBien - Chatwoot Relay | Receives Chatwoot webhooks, forwards to API at http://10.0.1.8:3000/ingest/chatwoot |
| Claude Database Access | Allows Claude to run SQL queries (ID: AofV_qusW1Vz9XZQtIksN) |

---

## Key Configuration

### AI Model
- **Model**: `claude-sonnet-4-5-20250929` (NOT claude-sonnet-4-5-20250514)
- **File**: `src/domain/ai/service.ts`

### Credit System
- Credits stored in: `users.credits_remaining` (NOT billing_accounts.credits)
- File: `src/domain/credits/service.ts`

### Database Schema (existing ViveBien tables)
The code was adapted to work with the existing database schema:
- `users` - has `credits_remaining` column
- `messages` - has `conversation_id` column (INTEGER)
- `conversation_state` - has `phase`, `message_count`, `onboarding_step`, `prompt_version`, `metadata`
- `credit_transactions` - for tracking credit usage
- `ai_usage` - for logging AI API calls

---

## Known Issues & Fixes Applied

### Database Schema Fixes (already applied)
```sql
-- These were added during setup:
ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(2) DEFAULT 'es';
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS phase VARCHAR(50) DEFAULT 'onboarding';
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS message_count INTEGER DEFAULT 0;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS onboarding_step INTEGER;
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(50);
ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER;
```

### Code Fixes Applied
1. **Credit service** - Changed from `billing_accounts.credits` to `users.credits_remaining`
2. **Credit retry logic** - Fixed to return `hasCredits: true` when status is "reserved" (idempotent retries)
3. **AI model name** - Changed to `claude-sonnet-4-5-20250929`
4. **Worker script** - Added `"worker": "node dist/worker/index.js"` to package.json

### Operational Fixes
1. **Health check fails** - Run after each deploy:
   ```bash
   docker service update --no-healthcheck projecto-1_vivebien-core-api
   docker service update --no-healthcheck projecto-1_vivebien-core-worker
   ```
2. **DNS not working between services** - Using IP address (10.0.1.8) instead of hostname

---

## Workflow for Code Changes

1. Claude makes changes locally in `/sessions/bold-inspiring-brahmagupta/mnt/vivebien-project/vivebien-core`
2. Claude pushes to GitHub: `git add . && git commit -m "message" && git push origin main`
3. User clicks Deploy in Easypanel
4. If health check fails, run the `--no-healthcheck` commands above

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `src/api/routes/ingest.ts` | Receives webhooks from n8n, extracts phone/message |
| `src/worker/handlers/inbound.ts` | Main message processing pipeline |
| `src/domain/credits/service.ts` | Credit check, reserve, confirm |
| `src/domain/ai/service.ts` | Claude API calls |
| `src/domain/conversation/service.ts` | Context loading, message saving |
| `src/adapters/chatwoot/client.ts` | Sends responses back to Chatwoot |

---

## Environment Variables (in Easypanel)

### API Service
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `PORT` - 3000
- `ANTHROPIC_API_KEY` - Claude API key
- `CHATWOOT_API_KEY` - Chatwoot access token
- `CHATWOOT_BASE_URL` - Chatwoot instance URL
- `CHATWOOT_ACCOUNT_ID` - Account ID

### Worker Service
- Same as API, uses shared Redis for BullMQ

---

## Testing

Send a WhatsApp message to the connected number. The flow:
1. Message arrives at Chatwoot
2. Chatwoot webhook triggers n8n workflow
3. n8n forwards to API (http://10.0.1.8:3000/ingest/chatwoot)
4. API queues job in BullMQ
5. Worker processes: loads user → checks credits → calls Claude → saves messages → sends response
6. User receives response on WhatsApp

---

## Last Updated
February 1, 2026 - Full pipeline working end-to-end
