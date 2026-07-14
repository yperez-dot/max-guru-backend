# Max Knowledge Base

Knowledge documents for the Max Medicare AI assistant.  
These files get imported into Max's data layer when the system is deployed.

## Structure

```
max-knowledge/
├── carriers/          # Per-carrier plan rules, transitions, non-commissionables
├── compliance/        # CMS rules, TPMO, SEP guidance
├── benefits/          # Benefit details by plan/carrier
└── operations/        # Enrollment procedures, contacts, certifications
```

## Files

### carriers/
| File | Content | Updated |
|------|---------|---------|
| `elevance-simply-plan-transitions-noncommissionable.md` | Simply Healthcare plan transitions (1/1/2026) + non-commissionable plan list + agent Q&A | 2026-07-10 |
| `humana-noncommissionable-florida-2026.md` | Official Humana carrier doc — all FL non-commissionable plans across 3 effective date batches (1/1, 4/1, 6/1). THEI grid cross-reference included. | 2026-07-10 |
| `florida-noncommissionable-plans-2026.md` | Full FL non-commissionable MA plan list — all carriers, from CMS 4.1.2026 landscape files. 36 non-commissionable plans, 529K enrolled. | 2026-07-10 |
| `thei-plan-grid-noncommissionable.md` | The 11 non-commissionable plans within THEI's 147-plan grid, with data schema for backend import. | 2026-07-10 |
| `max-behavior-rules.md` | Max system prompt rules — how to handle non-commissionable plans during comparisons (neutral heads-up, never ranking factor, renewal/new-sale distinction). | 2026-07-10 |

## How to use (once Max is deployed)
These markdown files get chunked and indexed into Max's retrieval layer.  
Each file should be self-contained with enough context for Max to answer agent questions accurately.
