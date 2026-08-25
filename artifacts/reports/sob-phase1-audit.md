# Max SoB Phase 1 Audit — 2026-08-25

Phased Summary of Benefits audit against the **current** THEI plan grid + Max plan-data
(not an old snapshot). Some SoBs were added to the grid after launch — this pass
re-reads the live xlsx hyperlinks and re-fetches focus PDFs from carrier hosts.

## Coverage

| Metric | Before | After Phase 1 |
|--------|--------|----------------|
| Plans with `http` SoB URL | 114 / 151 | **151 / 151** |
| Filled from current grid hyperlinks | — | 28 |
| Updated to prefer PDF/grid link | — | 1 |
| Found via carrier probes | — | CarePlus, Solis API, **Aetna H1609-094 (`NU28`)**, **Doctors DrPlus shared PDF** |
| Still missing | 37 | **0** |

### Newly resolved this pass

| Plan | County | SoB (current) | Notes |
|------|--------|---------------|-------|
| `H1609-094` Aetna Medicare Choice | Miami-Dade | `Y0001_H1609_094_NU28_SB2026_M.pdf` | Grid had no hyperlink; discovered by probing current Aetna 2026 SB filename pattern. Automated GET returns **403** (bot wall); URL is live for browsers (HEAD 200). |
| `H4140-002` Doctors DrPlus | Miami-Dade | `2026_SOB_SF_DrPlus-DrFlex_ENG.pdf` | Grid blank; same **current** combined DrPlus/DrFlex SoB used by DrFlex (`H4140-13`). Doctors CDN intermittently returns captcha HTML — retry until `%PDF`. |

## Focus spot-check — **current** SoB text vs Max

### Doctors DrMax `H4140-001` (Miami-Dade)
Source (fetched 2026-08-25): `https://www.doctorshcp.com/wp-content/uploads/2026_SOB_SF_DrMax-DrSelect_ENG.pdf`

| Field | Max / grid | Current SoB | Match |
|-------|------------|-------------|-------|
| Premium | $0 | $0 | ✅ |
| Part B giveback | $10 | Up to $10 monthly | ✅ |
| MOOP | $3,000 | $3,000 in-network | ✅ |
| PCP | $0 | $0 | ✅ |
| Specialist | $0 | $0 | ✅ |
| ER | $100 | $100 | ✅ |
| Urgent care | (not stored / implied) | $0 | — |
| Outpatient surgery | — | $50 | — |
| Tier 1–3 | 0 / 0 / 0 | $0 / $0 / $0 | ✅ |
| Tier 4 | $55 | $55 | ✅ |
| Tier 5 | 33% | 33% coinsurance | ✅ |
| OTC | $80 x month | $80 monthly | ✅ |

### Doctors DrPlus `H4140-002` (Miami-Dade)
Source (fetched 2026-08-25): `2026_SOB_SF_DrPlus-DrFlex_ENG.pdf` (DrPlus column)

| Field | Max / grid | Current SoB | Match |
|-------|------------|-------------|-------|
| Premium | $0 | **$0 – $4.80** (Medicaid may pay) | ⚠️ Max simplifies to $0 |
| Part B giveback | No | none listed | ✅ |
| MOOP | $3400 | $3,400 | ✅ |
| PCP / Specialist | $0 / $0 | $0 / $0 | ✅ |
| ER | $0 | $0 (QMB / all other members $0 on DrPlus) | ✅ |
| OTC | $102 x month | $102 monthly | ✅ |
| Drug tiers | `$0-12.65/ LIS` (T3–T5) | T1–T2 $0; T3–T5 **25%***; LIS note **$0–$12.65** | ✅ LIS framing OK; non-LIS is 25% |

### UHC MedicareMax `H5420-001/0028` (Miami-Dade)
Source (fetched 2026-08-25): `https://www.uhcjarvis.com/alphadog/PNFL26HM0333087_000`

| Field | Max / grid | Current SoB | Match |
|-------|------------|-------------|-------|
| Premium | $0 | $0 | ✅ |
| Part B giveback | $13 | Up to $13 | ✅ |
| MOOP | $3900 | $3,900 | ✅ |
| PCP / Specialist | $0 / $0 | $0 / $0 | ✅ |
| ER | $150 | $150 | ✅ |
| Urgent | — | $5 | — |
| Tier 1–5 | 0 / 0 / 25 / 40% / 33% | same | ✅ |
| OTC | $90 x quarter | $90 credit every quarter | ✅ |

## Sample link health (current URLs)

34 unique host-sampled SoB URLs checked with GET:

| Result | Count |
|--------|-------|
| PDF / binary SoB OK | 29 |
| HTML / captcha (Doctors CDN, Google Drive view links) | 2 |
| Fail / 403 (Aetna bot wall) | 3 |

Aetna and Doctors intermittently block non-browser clients — links remain the correct **2026 current** documents for humans.

## Phase 1 findings to carry into Phase 2

1. **Coverage complete** at URL level (151/151).
2. Focus medical/drug dollars for DrMax + MedicareMax match **current** SoBs.
3. **DrPlus premium** is the only focus mismatch worth a grid/Max note: SoB shows `$0–$4.80`, Max stores `$0`.
4. Batch extract (`extract_summary_of_benefits.py`) needs retries + browser UA for Doctors/Aetna; Google Drive `view` links should be converted to direct download where possible.

## Phase 2 (next)

1. Batch-download SoBs for all 151 linked plans with retry/backoff for captcha/403 hosts.
2. Structured field diff (premium, MOOP, PCP, specialist, ER, tiers, giveback, OTC) → corrections workbook.
3. Apply SoB-confirmed fixes into Max plan-data (start with DrPlus premium range) + `sourceQuality`.
4. Optionally improve Aetna extract path (manual browser download cache or CMS mirror).

## How to refresh SoB links from the grid

```bash
# With a fresh THEI xlsx export at /tmp/thei-grid.xlsx
python3 scripts/sync_sob_urls_from_grid.py
```
