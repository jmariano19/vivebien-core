# ViveBien Core - Easypanel Deployment Guide

This guide walks you through deploying vivebien-core to Easypanel with GitHub CI/CD.

## Prerequisites

1. Easypanel server running
2. GitHub repository with vivebien-core code
3. Existing PostgreSQL database (your ViveBien production DB)
4. API keys for Anthropic, OpenAI (optional), and Chatwoot

---

## Step 1: Create Easypanel Project

1. Log into your Easypanel dashboard
2. Click **Create Project**
3. Name it: `vivebien-core`

---

## Step 2: Add Redis Service

1. In the project, click **Add Service** → **Redis**
2. Configure:
   - **Name:** `redis`
   - **Image:** `redis:7-alpine`
   - **Command:** `redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy noeviction`
   - **Volume:** Create volume `redis_data` mounted at `/data`
3. Click **Deploy**

---

## Step 3: Add API Service

1. Click **Add Service** → **App**
2. Configure:
   - **Name:** `api`
   - **Source:** GitHub
   - **Repository:** Select your `vivebien-core` repo
   - **Branch:** `main`
   - **Build:** Dockerfile
   - **Dockerfile Path:** `Dockerfile`

3. **Domains:**
   - Add domain: `api.vivebien.io` (or your domain)
   - Enable HTTPS

4. **Ports:**
   - Container Port: `3000`

5. **Environment Variables:**
```
NODE_ENV=production
PORT=3000
API_SECRET_KEY=<generate-secure-32-char-key>
DATABASE_URL=postgres://user:pass@your-postgres-host:5432/vivebien
REDIS_URL=redis://redis:6379
ANTHROPIC_API_KEY=sk-ant-xxx
OPENAI_API_KEY=sk-xxx
CHATWOOT_URL=https://chatwoot.vivebien.io
CHATWOOT_API_KEY=xxx
CHATWOOT_ACCOUNT_ID=1
WORKER_CONCURRENCY=50
LOG_LEVEL=info
CORS_ORIGINS=https://patients.vivebien.io
```

6. **Health Check:**
   - Path: `/health`
   - Port: `3000`
   - Interval: `30s`

7. **Replicas:** `2` (for zero-downtime deployments)

8. Click **Deploy**

---

## Step 4: Add Worker Service

1. Click **Add Service** → **App**
2. Configure:
   - **Name:** `worker`
   - **Source:** GitHub (same repo)
   - **Branch:** `main`
   - **Build:** Dockerfile
   - **Command Override:** `node dist/worker/index.js`

3. **No domain needed** (internal service)

4. **Environment Variables:**
   (Same as API, plus:)
```
WORKER_CONCURRENCY=100
JOB_TIMEOUT_MS=120000
```

5. **Replicas:** `3` (scale based on load)

6. Click **Deploy**

---

## Step 5: Enable Auto-Deploy

For each service (API and Worker):

1. Go to service → **Source** tab
2. Enable **Auto Deploy**
3. This creates a webhook in your GitHub repo
4. Every push to `main` triggers a rebuild and deploy

---

## Step 6: Verify Deployment

1. **Health Check:**
```bash
curl https://api.vivebien.io/health
```

Expected response:
```json
{
  "status": "healthy",
  "version": "0.1.0",
  "checks": {
    "database": { "status": "ok" },
    "redis": { "status": "ok" },
    "queue": { "status": "ok", "waiting": 0 }
  }
}
```

2. **Test Admin API:**
```bash
curl -H "X-API-Key: your-secret-key" \
  https://api.vivebien.io/admin/flags
```

---

## Step 7: Configure n8n Thin Workflow

Create a new n8n workflow that forwards Chatwoot webhooks:

### Nodes:

1. **Webhook Trigger** (Chatwoot)
   - Method: POST
   - Path: `/chatwoot-relay`

2. **HTTP Request**
   - Method: POST
   - URL: `https://api.vivebien.io/ingest/chatwoot`
   - Headers:
     - `X-API-Key`: `{{$env.VIVEBIEN_API_KEY}}`
     - `Content-Type`: `application/json`
   - Body: `{{ $json }}`

3. **IF** (Check response)
   - Condition: `{{ $json.success }}` equals `false`

4. **Chatwoot** (Fallback - only if core fails)
   - Send message: "Lo siento, estamos experimentando problemas técnicos."

### Workflow JSON:

```json
{
  "name": "ViveBien Relay",
  "nodes": [
    {
      "name": "Chatwoot Webhook",
      "type": "n8n-nodes-base.webhook",
      "position": [250, 300],
      "parameters": {
        "httpMethod": "POST",
        "path": "chatwoot-relay"
      }
    },
    {
      "name": "Forward to Core",
      "type": "n8n-nodes-base.httpRequest",
      "position": [450, 300],
      "parameters": {
        "method": "POST",
        "url": "https://api.vivebien.io/ingest/chatwoot",
        "headers": {
          "X-API-Key": "={{$env.VIVEBIEN_API_KEY}}"
        },
        "sendBody": true,
        "bodyParameters": {
          "parameters": []
        },
        "jsonBody": "={{ $json }}",
        "options": {
          "timeout": 10000
        }
      }
    }
  ]
}
```

---

## Scaling Guide

### When to Scale Workers

| Queue Waiting | Action |
|---------------|--------|
| < 100 | Normal operation |
| 100-500 | Consider adding 1 worker |
| 500-1000 | Add 2 workers |
| > 1000 | Add workers until queue stabilizes |

### How to Scale

In Easypanel:
1. Go to Worker service → **Settings**
2. Increase **Replicas**
3. Click **Save**

Or via Easypanel API:
```bash
curl -X PATCH https://easypanel.yourserver.com/api/services/vivebien-core/worker \
  -H "Authorization: Bearer $EASYPANEL_TOKEN" \
  -d '{"replicas": 5}'
```

---

## Monitoring

### Key Metrics to Watch

1. **Queue Depth:** `GET /health` → `checks.queue.waiting`
2. **Error Rate:** Check worker logs for `Job failed` entries
3. **Response Time:** Monitor p95 latency in Chatwoot

### Alerting Recommendations

Set up alerts for:
- Queue waiting > 1000 for > 5 minutes
- Health check fails for > 1 minute
- Worker replica count < expected

---

## Rollback Procedure

If a deployment causes issues:

1. In Easypanel, go to service → **Deployments**
2. Find the previous working deployment
3. Click **Rollback**

Or revert the GitHub commit:
```bash
git revert HEAD
git push origin main
```
Auto-deploy will redeploy the previous version.

---

## Troubleshooting

### API returns 503
- Check Redis connection: `redis-cli ping`
- Check PostgreSQL connection
- Review API logs in Easypanel

### Jobs not processing
- Check worker logs for errors
- Verify Redis is accessible from workers
- Check `WORKER_CONCURRENCY` setting

### High memory usage
- Reduce `WORKER_CONCURRENCY`
- Check for memory leaks in job handlers
- Consider adding more worker replicas with lower concurrency each

---

## Security Checklist

- [ ] `API_SECRET_KEY` is unique and secure (32+ characters)
- [ ] HTTPS enabled on API domain
- [ ] Database credentials are not exposed
- [ ] Environment variables stored securely in Easypanel
- [ ] Redis is only accessible internally (no public port)
- [ ] Logs do not contain sensitive data
