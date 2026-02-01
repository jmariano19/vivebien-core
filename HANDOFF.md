# ViveBien / Confianza - Project Handoff

## Quick Context
**Confianza** (formerly Care Log) is a WhatsApp-based AI health companion that helps users track symptoms and prepare doctor-ready summaries between visits.

---

## 🔧 How Claude Has Access

### 1. Database Access (via n8n)
**Workflow:** `CareLog_Claude Database Access`
**Workflow ID:** `AofV_qusW1Vz9XZQtIksN`

Example query:
```
Execute workflow with inputs:
{
  "type": "webhook",
  "webhookData": {
    "body": {
      "sql": "SELECT * FROM messages ORDER BY created_at DESC LIMIT 10"
    }
  }
}
```

**Database Tables:**
- `users` - User profiles (id, phone, language, created_at)
- `messages` - Conversation history (id, user_id, role, content, created_at)
- `conversation_state` - User state tracking (phase, onboarding_step, message_count)
- `memories` - Health summaries (id, user_id, content, category='health_summary')

### 2. n8n Workflows (Only 2)
| Workflow | Purpose |
|----------|---------|
| **Care Log - Chatwoot Relay** | Handles WhatsApp messages via Chatwoot |
| **CareLog_Claude Database Access** | Database queries for Claude (ID: AofV_qusW1Vz9XZQtIksN) |

### 3. Code Access (Local Folder → GitHub)
- **Local Path:** `/mnt/vivebien-project/vivebien-core/`
- **GitHub Repo:** https://github.com/jmariano19/vivebien-core

**Workflow:**
1. Edit files in `/mnt/vivebien-project/vivebien-core/src/...`
2. `git add` + `git commit` + `git push`
3. Deploy manually in Easypanel

### 4. Deployment (Easypanel)
- **API Service:** vivebien-core-api
- **Dashboard:** carelog.vivebien.io

---

## 📁 Key Files

```
src/domain/ai/service.ts          # Claude API calls, language detection, summary generation
src/domain/conversation/service.ts # System prompt, templates, safety checks
src/workers/ingest.worker.ts      # WhatsApp message processing
src/config.ts                     # Environment variables
Dockerfile                        # Container config (HEALTHCHECK NONE)
package.json                      # Dependencies (@fastify/static v6.12.0)
```

---

## 🤖 Current Configuration

### Agent Identity
- **Name:** Confianza
- **Description:** AI health companion
- **Conversation Model:** Claude Opus 4.5 (`claude-opus-4-5-20251101`)
- **Summary Model:** Claude Sonnet 4.5 (cost-effective)

### Supported Languages
- Spanish (es) ✓
- English (en) ✓
- Portuguese (pt) ✓
- French (fr) ✓

### Onboarding Flow (7 Steps)
1. 3-Message Open (greeting, boundary, invitation)
2. Micro-Capture (what, when, pattern)
3. Immediate "Aha" Output (mini summary)
4. Name Request (optional, after value)
5. Trust & Control message
6. 3 Rails (log, prepare, summarize)
7. Ongoing conversation

### Safety Checks
- Medical emergencies → Recommend urgent care
- Crisis/self-harm → Escalate to crisis protocol
- Red flags: chest pain, stroke symptoms, pregnancy emergencies

---

## 🌐 Live URLs

| Service | URL |
|---------|-----|
| Dashboard | https://carelog.vivebien.io |
| WhatsApp | Connected via Chatwoot |

---

## ✅ What's Working

- WhatsApp messages receiving replies
- Multi-language support (ES, EN, PT, FR)
- Agent renamed to "Confianza"
- Claude Opus 4.5 for conversations
- Dashboard showing health summaries
- Doctor-ready summary format

---

## 🎯 Next Focus Areas

### Immediate
1. Test language adaptation - Send "hello", "hola", "olá", "bonjour"
2. Verify deployment is live

### Short-term
1. Onboarding polish - Fine-tune the 7-step flow
2. Summary quality - Improve doctor-ready format
3. Dashboard enhancements

### Future
1. Visit preparation mode
2. Timeline view
3. Export/share summaries
4. Proactive reminders

---

## 💬 Example SQL Queries

```sql
-- Get recent messages
SELECT * FROM messages ORDER BY created_at DESC LIMIT 10;

-- Get user's health summary
SELECT content FROM memories
WHERE user_id = '[user-id]' AND category = 'health_summary';

-- Check conversation state
SELECT * FROM conversation_state WHERE user_id = '[user-id]';

-- Count messages per user
SELECT user_id, COUNT(*) FROM messages GROUP BY user_id;
```

---

## 🔑 Important Notes

### Deployment
- Run `npm run build` locally to check TypeScript errors before pushing
- Easypanel pulls from GitHub main branch
- Health check disabled (`HEALTHCHECK NONE` in Dockerfile)

### Package Versions
- `@fastify/static`: v6.12.0 (NOT v9.x - requires Fastify 5.x)
- Fastify: 4.x

---

## 🚀 Quick Start for New Session

1. **Tell Claude:** "Read the HANDOFF.md in vivebien-project folder"
2. **Or paste this context** into a new conversation
3. Claude will have access to:
   - Database via n8n workflow `CareLog_Claude Database Access`
   - Code via local folder `/mnt/vivebien-project/vivebien-core/`

---

*Last updated: February 1, 2026*
