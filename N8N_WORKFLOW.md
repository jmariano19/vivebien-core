# ViveBien - n8n Workflow Specification

> ⚠️ **DEPRECATED (Feb 5, 2026)**: n8n is NO LONGER required for CareLog.
> Chatwoot webhooks now go directly to the API at `https://carelog.vivebien.io/ingest/chatwoot`.
> This document is kept for historical reference only.

---

This document specifies the minimal n8n workflow that replaces your complex processing workflow.

## Overview

The new workflow has **3 nodes** (down from 20+):
1. Chatwoot Webhook Trigger
2. HTTP Request to vivebien-core
3. Fallback Response (only if core fails)

## Workflow Diagram

```
┌─────────────────────┐
│  Chatwoot Webhook   │
│     Trigger         │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   HTTP Request      │
│ POST /ingest/chatwoot│
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐     ┌─────────────────────┐
│   IF: success?      │────▶│   Send Fallback     │
│   (Check response)  │ No  │   via Chatwoot      │
└──────────┬──────────┘     └─────────────────────┘
           │ Yes
           ▼
┌─────────────────────┐
│       Done          │
└─────────────────────┘
```

## Node Configuration

### Node 1: Chatwoot Webhook Trigger

**Type:** `n8n-nodes-base.webhook`

**Settings:**
- HTTP Method: `POST`
- Path: `vivebien-relay`
- Response Mode: `Immediately`
- Response Code: `200`

### Node 2: HTTP Request (Forward to Core)

**Type:** `n8n-nodes-base.httpRequest`

**Settings:**
- Method: `POST`
- URL: `https://api.vivebien.io/ingest/chatwoot`
- Authentication: None (we use header)
- Headers:
  - `X-API-Key`: `{{ $env.VIVEBIEN_API_KEY }}`
  - `Content-Type`: `application/json`
- Body Content Type: `JSON`
- Body: `{{ JSON.stringify($json) }}`
- Options:
  - Timeout: `10000` (10 seconds)
  - Continue On Fail: `true`

### Node 3: IF (Check Success)

**Type:** `n8n-nodes-base.if`

**Conditions:**
```
{{ $json.success === false || $json.error }}
```

If TRUE (failed) → Go to Fallback node
If FALSE (success) → End

### Node 4: Chatwoot Fallback (Only on failure)

**Type:** `n8n-nodes-chatwoot.chatwoot`

**Settings:**
- Resource: `Message`
- Operation: `Create`
- Conversation ID: `{{ $('Chatwoot Webhook Trigger').item.json.conversation.id }}`
- Message:
```
Lo siento, estamos experimentando problemas técnicos. Por favor intenta de nuevo en unos minutos.
```

## Environment Variables

Add these to your n8n environment:

```bash
VIVEBIEN_API_KEY=your-api-secret-key
```

## Complete Workflow JSON

Copy this JSON and import it into n8n:

```json
{
  "name": "ViveBien Relay (Thin)",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "vivebien-relay",
        "responseMode": "responseNode",
        "options": {}
      },
      "id": "webhook",
      "name": "Chatwoot Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [250, 300],
      "webhookId": "vivebien-relay"
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.vivebien.io/ingest/chatwoot",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "X-API-Key",
              "value": "={{ $env.VIVEBIEN_API_KEY }}"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json) }}",
        "options": {
          "timeout": 10000
        }
      },
      "id": "http-request",
      "name": "Forward to Core",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [450, 300],
      "continueOnFail": true
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict"
          },
          "conditions": [
            {
              "id": "check-success",
              "leftValue": "={{ $json.success }}",
              "rightValue": false,
              "operator": {
                "type": "boolean",
                "operation": "equals"
              }
            }
          ],
          "combinator": "or"
        },
        "options": {}
      },
      "id": "if-failed",
      "name": "Check Success",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [650, 300]
    },
    {
      "parameters": {
        "resource": "message",
        "conversationId": "={{ $('Chatwoot Webhook').item.json.conversation.id }}",
        "message": "Lo siento, estamos experimentando problemas técnicos. Por favor intenta de nuevo en unos minutos."
      },
      "id": "fallback",
      "name": "Send Fallback",
      "type": "n8n-nodes-chatwoot.chatwoot",
      "typeVersion": 1,
      "position": [850, 400],
      "credentials": {
        "chatwootApi": {
          "id": "YOUR_CHATWOOT_CREDENTIAL_ID",
          "name": "Chatwoot"
        }
      }
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}"
      },
      "id": "respond",
      "name": "Respond Success",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [850, 200]
    }
  ],
  "connections": {
    "Chatwoot Webhook": {
      "main": [
        [
          {
            "node": "Forward to Core",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Forward to Core": {
      "main": [
        [
          {
            "node": "Check Success",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Check Success": {
      "main": [
        [
          {
            "node": "Send Fallback",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Respond Success",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

## Migration Steps

1. **Create new workflow** in n8n using the JSON above
2. **Update Chatwoot webhook URL** to point to the new workflow
3. **Test with a single message** - verify it goes through vivebien-core
4. **Gradually shift traffic:**
   - Week 1: 10% to new workflow (using n8n Switch node in old workflow)
   - Week 2: 50% traffic
   - Week 3: 100% traffic
5. **Disable old workflow** (keep as backup for 1 month)
6. **Delete old workflow** after validation period

## Monitoring

Check these in n8n:
- Execution success rate (should be > 99%)
- Fallback message sends (should be rare)
- Execution time (should be < 1 second)

If fallback sends increase, check:
1. vivebien-core health: `curl https://api.vivebien.io/health`
2. Worker status in Easypanel
3. Redis connectivity

## Fallback Behavior

The fallback only triggers when:
- vivebien-core returns `{ success: false }`
- vivebien-core is unreachable (timeout)
- HTTP error (5xx, network error)

In these cases, users receive a friendly message asking them to try again.

## Benefits of This Approach

| Metric | Old Workflow | New Workflow |
|--------|--------------|--------------|
| Nodes | 20+ | 4 |
| Execution time | 5-10s | < 1s |
| Debugging | Complex | Simple |
| Maintenance | High | Low |
| Scalability | Limited | Unlimited |
| Feature changes | Edit n8n | Deploy code |
