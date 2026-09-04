# Plan year 2027 — what Max can answer

Agents may ask for **2027** anytime. If Max has the fact, he answers it and cites 2027. If he does not, he says so. He does **not** refuse because the live plan grid is still 2026, and he does **not** recycle 2026 dollars as 2027.

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
| Aetna 2027 (including new Partial Dual Select H1609-103) | `carriers/aetna-plans-florida-2027` |
| 2027 hospital cuts (UM / Bascom Palmer off MedicareMax 1/1/2027) | `carriers/hospital-networks-2027` |

## Plan dollars

Live `#plan-data` is the **2026** THEI grid (151 plans). That is current-year coverage, not a 2027 gag.

Working 2027 workbook (another desk is still filling it; official leftover SoBs due **Oct 1, 2026**):  
https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/edit

- **Green cells are on file** for Humana, Devoted, UHC, CarePlus, and Aetna — cite those 2027 numbers from the carrier `*2027*` docs. Yellow leftover 2026 cells were **not** imported.
- **Still no 2027 dollars** for Doctors, Florida Blue, HealthSpring/Cigna, HealthSun, Simply, Solis, Wellcare, Gold Kidney. Say “I don’t have that 2027 figure yet.”
- Refresh: `scripts/export_2027_grid_to_kb.py` (green cells only). Do not write this sheet into live `#plan-data`.

## How to cite

- 2027 rule / AEP / blackout → name the Hub or KB doc.
- 2027 plan benefit → name carrier, plan, CMS ID, **plan year 2027**, and the SoB if you have the link.
- If they did not specify a year and the question is a current-coverage quote, use the 2026 grid.
