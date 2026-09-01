# Max Knowledge Base

Knowledge documents for **Max** (THEI Medicare guru — not Igor). Railway loads these for `search_knowledge` / `get_knowledge_doc`.

Cursor / desk brief: repo-root [MAX.md](../MAX.md) (read that first). Identity: [AGENTS.md](../AGENTS.md). Watcher prompt: [WATCHER.md](../WATCHER.md).

## Layout

```
max-knowledge/
├── hub/                 # Agent Medicare Hub pack (bot version of the Hub)
│   ├── seps-by-state/   # SEP tracker split by state (use FL for Florida)
│   ├── sep-tracker.md   # Full SEP snapshot
│   ├── compliance.md
│   ├── medicare-basics.md
│   └── ...
├── carriers/            # Per-carrier notes, non-commissionables, blackouts
└── *.md                 # Medicare reference, hospitals, contacts, behavior rules
```

## How to add to the KB

Live Max only searches files under `max-knowledge/`. Root `MAX.md` is for Cursor Max, not the chatbot.

1. **Add or edit a `.md` file** under `max-knowledge/` (or `max-knowledge/carriers/` for one carrier).
2. **Name it so search hits.** The tool key is the path without `.md`:
   - `max-knowledge/plan-year-2027.md` → `plan-year-2027`
   - `max-knowledge/carriers/humana-plans-florida-2027.md` → `carriers/humana-plans-florida-2027`
3. **Put the year, carrier, county, and CMS IDs in the title and first lines** (`Humana`, `2027`, `H1036-054`, `Miami-Dade`). Search is plain text, not semantic.
4. **Cite the source** at the top (SoB URL, Hub page, date). Yellow / unconfirmed facts stay out.
5. **Merge to `main` and let Railway redeploy.** The KB loads from disk on boot. There is no admin “upload a note” button. Only the SEP pack hot-reloads (`POST /admin/refresh-seps` or the 24h job).
6. **Ask Max the question** after deploy. If he misses it, the filename or first heading probably lacks the words you used.

Do **not** put 2027 plan dollars only in `#plan-data` (that JSON is still the 2026 grid). Write confirmed 2027 numbers into a `*2027*.md` file so chat can cite them.

Hub pages (compliance, AEP training, etc.): update the Hub repo, then `python3 scripts/import_hub_knowledge.py` (clone `agent-medicare-hub` to `/tmp/amh` first). SEPs: `python3 scripts/refresh_sep_tracker.py`.

## Plan grid vs Hub pack

| Need | Source |
|------|--------|
| Plan premiums, MOOP, copays, drug tiers, givebacks | Embedded PLAN DATA in `artifacts/max-demo-FINAL-v7.html` (THEI grid) |
| SEPs, compliance, SOA, certs, contracting, Hub ops | `max-knowledge/hub/*` via tools |

## Refresh Hub content

```bash
# SEP tracker (live Hub app — preferred; keeps Max in sync with agentmedicarehub.com)
python3 scripts/refresh_sep_tracker.py

# Other Hub pages (clone agent-medicare-hub to /tmp/amh first):
python3 scripts/import_hub_knowledge.py
```

SEP SoT is the live tracker HTML (`sep-tracker-app.html` /
https://www.agentmedicarehub.com/sep-tracker), not the older
`sep-tracker/data/seps.json` snapshot.

### Auto-refresh (production)

1. **Railway (runtime):** on boot + every `SEP_REFRESH_HOURS` (default **24**), Max pulls the live Hub tracker into `max-knowledge/hub/*` and reloads the in-memory KB. Disable with `SEP_REFRESH_ENABLED=false`. Manual: `POST /admin/refresh-seps` (requires API key + access token when gated).
2. **GitHub Actions (repo):** weekly Monday job opens a PR if the Hub changed, so deploys/cold starts stay current even before the runtime pull.
