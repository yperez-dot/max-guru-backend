# Moving Max to Grok (xAI)

Max's Railway `/chat` endpoint now calls **xAI Grok** instead of Anthropic Claude.

## Railway variables (required)

| Variable | Required | Notes |
|----------|----------|-------|
| `XAI_API_KEY` | **Yes** | From https://console.x.ai/ |
| `GROK_MODEL` | No | Default `grok-4.6` (500k context — fits the ~280KB system prompt) |
| `MAX_API_KEY` | Yes | Unchanged — Netlify → Railway auth |
| `ANTHROPIC_API_KEY` | No | Safe to remove after cutover |

## Response shape

The Netlify UI still expects Anthropic-style JSON:

```json
{ "content": [{ "type": "text", "text": "..." }], "toolResults": [] }
```

`services/grok.js` converts Grok/OpenAI chat-completions (+ tool calls) into that shape.

## Files

- `services/grok.js` — Grok client + tool loop
- `services/claude.js` — TOOLS / processTool only (name kept for now)
- `server.js` — `/chat` → Grok pass-through
- `artifacts/max-demo-FINAL-v7.html` — always hits Railway (no Claude.ai direct path)
