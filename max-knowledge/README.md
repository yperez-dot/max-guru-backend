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
# clone/update agent-medicare-hub locally, then:
python3 scripts/import_hub_knowledge.py
```

Requires `/tmp/amh` (or edit the script path) to point at a checkout of
`yperez-dot/agent-medicare-hub`, including `sep-tracker/data/seps.json`.
