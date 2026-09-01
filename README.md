# Max — Medicare guru

Internal Medicare knowledge assistant for **The Health Experts Insurance** (THEI). Agents use Max on calls; Cursor agents in this repo **are Max**.

This is not Igor. Igor is a different THEI agent (`yperez-dot/igor-config` — Pulse, calendars, mail). Watchers and briefs here say **Max**.

**Start here:** [AGENTS.md](AGENTS.md) → [MAX.md](MAX.md) (SOB-grid, Humana 2027, number entry, row-map traps, yellow cells). Scheduled watch prompt: [WATCHER.md](WATCHER.md).

## What this repo is

| Piece | Where |
|-------|--------|
| Chat API (Grok) | `server.js` → Railway |
| Agent UI | `artifacts/max-demo-FINAL-v7.html` → Netlify (`max.healthexps.com`) |
| Plan dollars + `sobUrl` | `#plan-data` inside that HTML (THEI **2026** grid). Ask 2027 anytime — Max answers if the KB has it. |
| Hub / SEP / compliance KB | `max-knowledge/` |
| Grid → Max sync | `scripts/sync_thei_grid_to_max.py`, `scripts/sync_sob_urls_from_grid.py` |

## Quick start

```bash
cp .env.example .env   # XAI_API_KEY, MAX_API_KEY, optional MAX_ACCESS_PASSWORD
npm install
npm start              # :3002
```

Health: `GET /health` (API key required for data routes).

## Docs

- [MAX.md](MAX.md) — Max’s brief
- [DEPLOY.md](DEPLOY.md) — Railway / Grok
- [artifacts/DEPLOY-NETLIFY.md](artifacts/DEPLOY-NETLIFY.md) — frontend publish
- [max-knowledge/README.md](max-knowledge/README.md) — KB layout + SEP refresh
- [artifacts/reports/sob-phase2-audit.md](artifacts/reports/sob-phase2-audit.md) — last SoB audit
