# Plan year 2027 — what Max can answer

Agents may ask for **2027** anytime. Live `#plan-data` **defaults to 2027** (AEP). If Max has the fact, he answers it and cites 2027. If a 2027 field is blank, he says unverified / pending SoB. He does **not** recycle 2026 dollars as 2027.

## Already on file (answer these)

| Topic | Where |
|-------|--------|
| AEP 2027 dates, SOA same-day (Oct 1, 2026), same-space events, Part D $2,400 cap | `hub/aep-2027-training`, `hub/compliance` |
| PY2027 regs: MOOP caps, Part D $700 / 25% / $2,400 TrOOP, insulin $35, LIS copays, PA transparency, superlatives | `medicare-reference` |
| 2027 MA contracting / transfer blackouts | `hub/contracting-blackout`, `carriers/2027-ma-blackout-dates` |
| 2027 confirmed plan dollars (green cells only) | `carriers/plan-grid-overview-2027`, then the carrier file |
| Humana 2027 (Gold Plus, Dual Select, Choice PPO) | `carriers/humana-plans-florida-2027` |
| Devoted 2027 (CORE, GIVEBACK, C-SNP, Dual, GIVEBACK EXTRAS H1290-110) | `carriers/devoted-plans-florida-2027` |
| UHC / MedicareMax / Preferred / AARP PPO 2027 | `carriers/uhc-plans-florida-2027` |
| CarePlus 2027 (including new CareBreeze H1019-154, CareFree Giveback H1019-065) | `carriers/careplus-plans-florida-2027` |
| Doctors 2027 (9 plans with green cells; DrMax, DrSelect, DrExtraCare, DrFullDual, DrPartialDual) | `carriers/doctors-plans-florida-2027` |
| Aetna 2027 (including new Partial Dual Select H1609-103) | `carriers/aetna-plans-florida-2027` |
| HealthSun 2027 (12 plans with green cells across Miami-Dade/Broward; includes VitalCare / MediSun Extra / MediSun Full Dual Extra) | `carriers/healthsun-plans-florida-2027` |
| 2027 hospital cuts (UM / Bascom Palmer off MedicareMax 1/1/2027) | `carriers/hospital-networks-2027` |
| HealthSpring / Cigna: **no** 2027 MA in Miami-Dade or Broward | `carriers/healthspring-plans-florida-2027` |

## Plan dollars

Live `#plan-data` is the **2027** THEI grid (AEP default). 2026 is archived as `#plan-data-2026`.

Working 2027 workbook:  
https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/edit

- **Non-yellow cells** (white/uncolored after the Oct 2026 restyle; classic green still counts) are on file in `#plan-data` and the carrier `*2027*` docs. Yellow leftover cells were **not** imported as 2027 dollars.
- **HealthSpring / Cigna is not a 2027 Miami-Dade or Broward MA option.** No plans to enroll into in those counties (CMS CY2027; grid columns removed). Do not quote 2026 HealthSpring dollars as 2027. A live Cigna directory hit ≠ consider HealthSpring. Leftover yellow workbook cells are stale. Cite `carriers/healthspring-plans-florida-2027`.
- **Yellow-heavy leftovers** (notably Gold Kidney medical dollars) stay pending SoB. If a field is blank on a 2027 plan, say unverified — do not fill from 2026.
- Refresh: `scripts/sync_thei_grid_to_max.py --year 2027` and `scripts/export_2027_grid_to_kb.py` (non-yellow cells only).

## How to cite

- 2027 rule / AEP / blackout → name the Hub or KB doc.
- 2027 plan benefit → name carrier, plan, CMS ID, **plan year 2027**, and the SoB if you have the link.
- If they did not specify a year and the question is a current-coverage quote, use the 2026 grid.
