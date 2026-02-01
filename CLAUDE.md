# ViveBien Core - Project Context

## Overview
ViveBien Core is a WhatsApp wellness platform using Fastify API + BullMQ workers deployed on Easypanel (Docker Swarm).

## Key URLs
- **Dashboard**: https://carelog.vivebien.io
- **API**: Deployed on Easypanel as `vivebien-core-api`
- **Worker**: Deployed as `vivebien-core-worker`

## Tech Stack
- **Framework**: Fastify 4.x
- **Queue**: BullMQ with Redis
- **Database**: PostgreSQL
- **AI**: Anthropic Claude API
- **Deployment**: Easypanel (Docker Swarm)

## Important Configurations

### Package Versions (Critical)
- `@fastify/static`: v6.12.0 (NOT v9.x - requires Fastify 5.x)
- `fastify`: ^4.28.0

### Dockerfile
- Health check is **disabled** (`HEALTHCHECK NONE`) - Easypanel handles monitoring
- Static files served from `/app/public`

### Database Schema
The `users` table has these columns (NO `last_message_at`):
- id, phone, name, language, timezone, created_at

The `memories` table stores health summaries:
- id, user_id, content, category, importance_score, access_count, last_accessed_at, created_at

## Care Log Dashboard

### Features
- Live health summaries for WhatsApp users
- User list with phone numbers, entry counts, phases
- Search by phone number
- Auto-refresh (10 second intervals)

### How Summaries Work
1. User sends WhatsApp message
2. Worker processes message via `inbound.ts` handler
3. After response, `conversationService.updateHealthSummary()` is called
4. AI generates/updates summary based on conversation history
5. Summary stored in `memories` table with `category = 'health_summary'`
6. Dashboard fetches from `/api/summary/users` and `/api/summary/user/:phone`

## Care Log Personality
The system uses "Care Log" personality:
- Calm, factual, supportive tone
- No emojis
- Adapts to user's language (Spanish/English/Portuguese)
- Focus on health logging, not emotional support

## Key Files
- `src/index.ts` - API entry point with static file serving
- `src/api/routes/summary.ts` - Dashboard API endpoints
- `src/domain/conversation/service.ts` - Health summary generation
- `src/domain/ai/service.ts` - AI service with `generateSummary()`
- `src/worker/handlers/inbound.ts` - Message processing
- `public/index.html` - React dashboard (single file)
- `migrations/001_core_tables.sql` - Database schema

## Common Issues & Solutions

### Container not starting (yellow dot in Easypanel)
- Usually health check issue - we disabled it permanently
- Check logs for actual error

### "Internal Server Error" on dashboard
- Usually database schema mismatch
- Check if querying non-existent columns
- Wrap queries in try-catch for optional tables

### @fastify/static version mismatch
- v7+ requires Fastify 5.x
- Use v6.12.0 for Fastify 4.x

### Summaries not generating
1. Check `memories` table exists
2. Check worker logs for errors
3. Verify `updateHealthSummary` is being called in `inbound.ts`

## n8n Integration
- Database access workflow: `Claude Database Access` (ID: AofV_qusW1Vz9XZQtIksN)
- Accepts POST with `{"sql": "..."}` to execute queries
