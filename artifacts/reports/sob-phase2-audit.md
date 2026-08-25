# Max SoB Phase 2 Audit — 2026-08-25

Batch extract of **current** Summary of Benefits PDFs + structured field diff vs Max
plan-data. Builds on Phase 1 URL coverage (151/151).

## Pipeline

| Step | Artifact |
|------|----------|
| Extract | `scripts/sob_phase2_extract.py` → `artifacts/reports/sob_extracted.json` |
| Diff | `scripts/sob_phase2_diff.py` → `sob-phase2-diff.csv` + `sob-phase2-corrections.xlsx` |
| Applied | `artifacts/reports/sob-phase2-applied-fixes.json` |

## Extract results

| Metric | Value |
|--------|-------|
| Unique plan keys with SoB | 150 (151 rows; 1 duplicate `H1032-206` Miami-Dade) |
| Text extracted | **150 / 150** |
| ≥1 field parsed | 149 |
| Notes | Aetna hosts often 403 to bots (URLs still valid in browser). Doctors CDN sometimes captcha — retries succeed. |

## Diff summary (post-fix)

After applying confirmed fixes and tightening parsers (ER header line, giveback `$` required, skip Extra Help premium cells):

| Severity | Rows | Notes |
|----------|------|-------|
| High (review) | ~4–13 | Mostly **dual-column SoBs** (Wellcare Giveback vs Simple, Cigna paired plans) where the first column is not this plan |
| Med | few | Residual premium range framing |

Full candidate list: `artifacts/reports/sob-phase2-corrections.xlsx`.

## Applied into Max plan-data (SoB-confirmed)

| Plan | Field | Old → New | Evidence |
|------|-------|-----------|----------|
| `H4140-002` DrPlus (Dade) | premium | `$0` → `$0 - $4.80` | Current `DrPlus-DrFlex` SoB |
| `H4140-13` DrFlex (Dade + Broward) | premium | `$0` → `$0 - $1.10` | Same SoB, DrFlex column |
| `H0982-022` Healthy Living (Dade) | tier3 / tier4 | `15` / `70` → `0` / `35` | `SB022_Eng_Current` |
| `H0982-007` Healthy Living (Broward) | sobUrl | Google Drive (actually 022 PDF) → `SB007_Eng_Current` | Solis API |
| `H0982-022` Broward row | sobUrl + giveback | Miami `SB022` → `SB007`; giveback `None` → `0` | Broward Healthy Living = SB007 benefits |

`sourceQuality` annotated with `SoB Phase2:<field>` on touched rows.

## Not auto-applied (needs human / dual-column care)

- **Wellcare `H1032-196`**: SoB is a 2-plan booklet (Giveback vs Simple). Parser prefers first column; Max values match Simple — leave as review.
- **Cigna `H1035-025`**: paired columns ($150/$130 ER, $20/$35 specialist) — verify which column is this plan ID before changing.
- **Devoted / Humana / Cigna DSNP premiums** showing `$0` on SoB while Max keeps `$0 / $4.80` Extra Help framing — intentional grid style; skipped.

## Phase 3 (optional next)

1. Column-aware parsing for multi-plan SoB booklets (match plan name / ID to column).
2. Manual clearance of remaining Wellcare/Cigna review rows.
3. Wire `sob_extracted` excerpts into Max knowledge for cite-backed answers (optional; large).
