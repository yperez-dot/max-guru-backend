# Max — Medicare guru

Internal Medicare knowledge assistant for **The Health Experts Insurance** (THEI). Agents use Max on calls; Cursor agents in this repo **are Max**.

This is not Igor. Igor is a different THEI agent (`yperez-dot/igor-config` — Pulse, calendars, mail). Watchers and briefs here say **Max**.

**Start here:** [AGENTS.md](AGENTS.md) → [MAX.md](MAX.md) (SOB-grid, Humana 2027, number entry, row-map traps, yellow cells). Scheduled watch prompt: [WATCHER.md](WATCHER.md).

## What this repo is

| Piece | Where |
|-------|--------|
| Chat API (Grok) | `server.js` → Railway |
| Agent UI | `artifacts/max-demo-FINAL-v7.html` → Netlify (`max.healthexps.com`) |
| Plan dollars + `sobUrl` / `eocUrl` | `#plan-data` inside that HTML (THEI **2027** grid, AEP default). 2026 archived as `#plan-data-2026`. SOB/EOC lookups use 2026 files only on a 2026-only ask; unspecified / 2027 / both years stay on 2027. |
| Hub / SEP / compliance KB | `max-knowledge/` |
| Grid → Max sync | `scripts/sync_thei_grid_to_max.py`, `scripts/sync_sob_urls_from_grid.py` |

## Quick start

```bash
cp .env.example .env   # XAI_API_KEY, MAX_API_KEY, optional MAX_ACCESS_PASSWORD
npm install
npm start              # :3002
```

Health: `GET /health` (API key required for data routes).

## Model provider (Railway Variables)

| `LLM_PROVIDER` | Key | Model var (default) |
|---|---|---|
| `grok` (default) | `XAI_API_KEY` | `GROK_MODEL` (`grok-4.6`) |
| `claude` | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL` (`claude-sonnet-5-5`) |
| `openai` | `OPENAI_API_KEY` | `OPENAI_MODEL` (`gpt-4.1`) |

Claude goes through the native Messages API (`services/anthropicChat.js`) with prompt caching on the system prompt and the latest turn, so repeated rounds of one chat read the plan grid at the cached rate. If the key is org-level (error: "must include the anthropic-workspace-id header"), also set `ANTHROPIC_WORKSPACE_ID` to the workspace ID from Console → Settings → Workspaces. To roll back, set `LLM_PROVIDER=grok`. `/health` shows `provider`, `model` and `claudeConfigured`.

## Image attach

Paste a screenshot into the composer or use the paperclip. Max accepts **PNG / JPEG / WebP** up to **4MB each** (up to 4 per message), shows thumbnails before send, and can send text + images in one turn. `/chat` forwards those data URLs to Grok vision (or OpenAI / Claude per `LLM_PROVIDER`). Images stay in memory for that request only — they are not written to disk. They do count toward the daily spend estimate. While a reply is in flight the composer stays enabled: Send queues the next question (and any new images) and auto-sends it when Max finishes — it does not cancel the current turn.

## Daily cost guard

Max keeps a shared daily spend estimate for Carolina, Katy, and Yahoska. The day rolls over in
`America/New_York`. Configure:

```bash
MAX_DAILY_BUDGET_USD=10
MAX_SOFT_WARN_PCT=50,80
```

The UI shows each warning threshold once per day. At 100%, Max pauses before the next model call
and asks for an explicit phrase such as `OK go over`, `override budget`, or `continue anyway`.
That unlock lasts only for the current New York day.

Usage is stored in `data/max-usage.json` by default. For restart-safe Railway persistence, mount a
volume and set `MAX_USAGE_FILE=/data/max-usage.json`. **Client workups** (Save / Open / Delete in
the sidebar) use the same volume: set `MAX_WORKUPS_FILE=/data/max-workups.json`. Each unlock email
(Yahoska / Carolina / Katy) has their own list — save on desktop, open on phone. `GET /usage`
requires both the Max API key and, when enabled, the invite-only access token; it reports today's
spend, budget, percentage, and override state.

Built-in price estimates cover the current default models (`grok-4.6` and `gpt-4.1`), including
cached input and Grok's 200K+ context tier. If the configured model changes, set
`MAX_MODEL_INPUT_USD_PER_M`, `MAX_MODEL_CACHED_INPUT_USD_PER_M`, and
`MAX_MODEL_OUTPUT_USD_PER_M`. `MAX_CONTEXT_NUDGE_TOKENS` controls the long-thread “start a new chat”
notice (default `120000`).

## Docs

- [MAX.md](MAX.md) — Max’s brief
- [DEPLOY.md](DEPLOY.md) — Railway / Grok
- [artifacts/DEPLOY-NETLIFY.md](artifacts/DEPLOY-NETLIFY.md) — frontend publish
- [max-knowledge/README.md](max-knowledge/README.md) — KB layout + SEP refresh
- [artifacts/reports/sob-phase2-audit.md](artifacts/reports/sob-phase2-audit.md) — last SoB audit
