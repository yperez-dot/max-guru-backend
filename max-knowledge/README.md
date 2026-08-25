# Max Knowledge Base

Knowledge documents for Max. Railway loads these for `search_knowledge` / `get_knowledge_doc`.

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
