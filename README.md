# ViveBien Core

Scalable backend service for ViveBien's WhatsApp-based wellness platform.

## Architecture

```
WhatsApp → Chatwoot → n8n (thin relay) → vivebien-core API → BullMQ → Workers → Claude AI
```

**Key Features:**
- Fastify API server with async job processing
- BullMQ workers for scalable message handling
- Admin API for live configuration updates
- Idempotent credit system
- Rate-limited AI calls

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 16+
- Redis 7+

### Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
psql $DATABASE_URL < migrations/001_core_tables.sql

# Start API (with hot reload)
npm run dev

# In another terminal, start worker
npm run dev:worker
```

### Using Docker

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f

# Scale workers
docker compose up -d --scale worker=3
```

## Project Structure

```
vivebien-core/
├── src/
│   ├── index.ts                 # API server entry point
│   ├── config.ts                # Environment configuration
│   ├── api/
│   │   ├── routes/
│   │   │   ├── health.ts        # Health check endpoints
│   │   │   ├── ingest.ts        # Webhook ingestion
│   │   │   └── admin.ts         # Admin API (flags, prompts, etc.)
│   │   └── middleware/
│   │       ├── correlation.ts   # Request correlation IDs
│   │       └── auth.ts          # API key authentication
│   ├── worker/
│   │   ├── index.ts             # Worker entry point
│   │   ├── processor.ts         # Job routing
│   │   └── handlers/
│   │       └── inbound.ts       # Message processing
│   ├── domain/
│   │   ├── user/                # User management
│   │   ├── credits/             # Credit system
│   │   ├── conversation/        # Conversation state
│   │   └── ai/                  # Claude integration
│   ├── adapters/
│   │   └── chatwoot/            # Chatwoot API client
│   ├── infra/
│   │   ├── db/                  # PostgreSQL client
│   │   ├── queue/               # BullMQ/Redis client
│   │   └── logging/             # Pino logger
│   └── shared/
│       ├── types.ts             # TypeScript types
│       ├── errors.ts            # Error classes
│       └── rate-limiter.ts      # Rate limiting
├── migrations/                   # SQL migrations
├── Dockerfile                    # Production Docker image
├── docker-compose.yml            # Local development setup
├── DEPLOYMENT.md                 # Easypanel deployment guide
└── N8N_WORKFLOW.md              # Thin n8n workflow spec
```

## API Endpoints

### Public
- `GET /health` - Full health check with metrics
- `GET /live` - Liveness probe
- `GET /ready` - Readiness probe

### Webhook
- `POST /ingest/chatwoot` - Chatwoot webhook receiver

### Admin (requires API key)
- `GET/POST /admin/flags` - Feature flags
- `GET/POST /admin/prompts` - Prompt versions
- `GET/POST /admin/templates` - Response templates
- `GET/POST /admin/costs` - Credit costs
- `GET/POST /admin/experiments` - A/B tests
- `GET /admin/stats` - Usage statistics

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | API server port | No (3000) |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `API_SECRET_KEY` | Admin API authentication | Yes |
| `ANTHROPIC_API_KEY` | Claude API key | Yes |
| `CHATWOOT_URL` | Chatwoot instance URL | Yes |
| `CHATWOOT_API_KEY` | Chatwoot API token | Yes |
| `WORKER_CONCURRENCY` | Jobs per worker | No (50) |

See `.env.example` for full list.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for Easypanel deployment instructions.

## n8n Migration

See [N8N_WORKFLOW.md](./N8N_WORKFLOW.md) for the thin relay workflow specification.

## Scaling

| Users | API Replicas | Worker Replicas | Worker Concurrency |
|-------|--------------|-----------------|-------------------|
| 0-1K | 2 | 2 | 50 |
| 1K-5K | 2 | 3 | 100 |
| 5K-10K | 3 | 5 | 150 |
| 10K+ | 5 | 8 | 200 |

## License

Private - ViveBien
