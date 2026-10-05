# 2027 THEI plan grid — what Max can cite
Source: THEI 2027 Plan Benefit Grid working copy ([Google Sheet](https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/edit))
Pulled: 2026-10-05 22:23 UTC
Sheet stamp: 5420 confirmed (non-yellow) / 274 yellow benefit cells across plan tabs.

Color key on the sheet: **yellow** = leftover / unconfirmed (never cited as 2027 dollars). After the Oct 2026 restyle, confirmed working 2027 numbers are typically **white/uncolored** (classic light-green fills were cleared; green still counts if it returns). Max only cites non-yellow cells.

Live `#plan-data` **defaults to 2027** (same confirmed-cell rule). 2026 is archived (`#plan-data-2026` / `artifacts/plan-data-2026.json`) for current-year quotes when the agent asks or toggles the year.

## Confirmed 2027 plan dollars (non-yellow)

| Carrier | Plans with confirmed 2027 cells | KB doc |
|---------|----------------------------------|--------|
| Humana | 19 | `carriers/humana-plans-florida-2027` |
| Devoted | 20 | `carriers/devoted-plans-florida-2027` |
| UHC | 14 | `carriers/uhc-plans-florida-2027` |
| CarePlus | 17 | `carriers/careplus-plans-florida-2027` |
| Aetna | 10 | `carriers/aetna-plans-florida-2027` |
| Doctors | 9 | `carriers/doctors-plans-florida-2027` |
| HealthSun | 12 | `carriers/healthsun-plans-florida-2027` |
| Florida Blue | 5 | `carriers/florida-blue-plans-florida-2027` |
| Simply | 2 | `carriers/simply-plans-florida-2027` |
| Solis | 10 | `carriers/solis-plans-florida-2027` |
| Wellcare | 5 | `carriers/wellcare-plans-florida-2027` |
| Gold Kidney | 5 | `carriers/gold-kidney-plans-florida-2027` |

## Not offered in Miami-Dade / Broward 2027

**HealthSpring / Cigna** has **no** 2027 Medicare Advantage plans in Miami-Dade or Broward (CMS CY2027; THEI Plan Comparison Grid columns removed). Do not quote 2026 HealthSpring dollars as 2027 benefits. A live Cigna/HealthSpring directory hit is not a 2027 enrollment option in those counties. Leftover yellow/workbook cells that mention HealthSpring or Cigna for Dade/Broward 2027 are stale — ignore them. Cite `carriers/healthspring-plans-florida-2027`.

## Still waiting on the official October 1 SoB

These carriers are on the 2027 workbook but every benefit cell is still yellow. Do **not** quote their 2026 leftover numbers as 2027. Say Max does not have that 2027 figure yet.


## New 2027 plans on the grid

- CarePlus CareFree Giveback (`H1019-065`) — Broward HMO
- CarePlus CareBreeze (`H1019-154`) — Broward C-SNP
- CarePlus CareBreeze (`H1019-154`) — Miami-Dade C-SNP
- Wellcare Dual Align Unity (HMO D-SNP) (`H1032-250`) — Broward D-SNP
- Wellcare Dual Align Unity (HMO D-SNP) (`H1032-250`) — Miami-Dade D-SNP
- Devoted C-SNP ENHANCED (`H1290-073`) — Broward C-SNP
- Devoted GIVEBACK EXTRAS (`H1290-110`) — Miami-Dade HMO
- Devoted GIVEBACK EXTRAS (`H1290-117`) — Broward HMO
- Aetna Medicare Partial Dual Select (`H1609-103`) — Broward D-SNP
- Aetna Medicare Partial Dual Select (`H1609-103`) — Miami-Dade D-SNP
- Doctors DrPartialDual-SFL (HMO D-SNP) (`H4140-020`) — Broward D-SNP
- Doctors DrPartialDual-SFL (HMO D-SNP) (`H4140-020`) — Miami-Dade D-SNP
- Doctors DrExtraCare (`H4140-024`) — Broward C-SNP
- Simply Complete Platinum (HMO D-SNP) (`H5471-125`) — Broward D-SNP
- Simply Complete Platinum (HMO D-SNP) (`H5471-125`) — Miami-Dade D-SNP
- Humana Choice Giveback (`H7617-145`) — Broward PPO
- Humana Choice Giveback (`H7617-145`) — Miami-Dade PPO

## Marked non-commissionable on the 2027 grid (new sales)

- FL Blue BlueMedicare (`H1035-017`)
- FL Blue Classic (`H1035-019`)
- FL Blue Premier HMO (`H1035-025`)
- AARP UHC Regional PPO FL-0031 (`R0759-001`)
- FL Blue Blue Medicare Value (`H5434-026`)
- FL Blue Blue Medicare Select (`H5434-002`)

## Hospital / network notes already confirmed for 2027

- **UHealth / University of Miami** and **Bascom Palmer** are **out of MedicareMax (Preferred Care Network)** as of **1/1/2027**. In-network through 12/31/2026. University Hospital on the Hospitals tab is HCA Davie — not UM.
- Other hospital Yes/— marks stay 2026 until a public 2027 directory lands (due Oct 1, 2026).

## Workbook notes (from the 2027 NOTES tab)

- 2027 Plan Benefit Grid — working copy
- The Health Experts Insurance · Doral, FL · 1-800-380-6821
- AEP October 15 – December 7, 2026 (for 2027 coverage)
- === Hospitals x Carrier CarePlus 2027 directory pass 2026-10-01 ===
- Sources: CarePlus 2027 Broward H1019FLHM01CG27 + Miami-Dade H1019FLHM01JG27 PDFs from careplushealthplans.com provider-directories (published ~10/01/2026).
- CarePlus drops: Memorial (all campuses) Yes→No; Mount Sinai Yes→No — absent from Hospitals sections.
- CarePlus reconfirmed in-network (left Yes): Broward Health campuses; HCA Northwest/University/Westside/Woodmont/Aventura/Kendall; Holy Cross; Florida Medical Center; Kindred Hollywood; Larkin (+Hollywood/Palm Springs); Jackson N/S/W + Memorial; Baptist Miami; Homestead; South Miami; West Kendall Baptist; Doctors; Coral Gables; Hialeah; Palmetto; Northshore; Mercy; Westchester.
- CarePlus still empty / not in hospital dirs (left unchanged): Bascom Palmer, University of Miami/UHealth, Cleveland Clinic, Bethesda — not listed as network hospitals.
- University Hospital row left alone (HCA Davie, not UM). Preferred Care Partner × UM left unchanged (PCN/MedicareMax termination is the documented drop; PCP not confirmed out for 2027).
- Evidence log: /workspace/uploads/sneaks/out/hospitals-2027-dir-log-2026-10-01.json
- Unverified: Jackson, Baptist SFL, Mount Sinai, HCA, Cleveland Clinic, Holy Cross, Mercy, Larkin, Steward/Hialeah/Palmetto/North Shore, Homestead, Coral Gables — left as prior Yes/empty pending carrier 2027 hospital directories.
- Hospitals: 2026 Yes/— stays unless a public 2027 directory says otherwise (due Oct 1, 2026).
- UHealth / University of Miami and Bascom Palmer × MedicareMax are out 1/1/2027.
- University Hospital on the Hospitals tab is HCA Davie — not UM. Leave it.
- Skip Palm Beach-only PBPs. Do not write one dual onto a sibling.
- Upload to your Drive: drive.google.com → New → File upload → this xlsx → Open with Google Sheets.
- Columns with a 2027 status stamp: 75 confirmed, 10 new, 4 exiting.
- Yellow leftover columns still need the official October 1 SOB.
- === Update log 2026-09-15 (agent write) ===
- Sources applied today:
- 1) Aetna_National_Plan_Grid_2027_First_Look-082826.xlsx — wrote/reconfirmed H1609-093,018,094,080,043,073,103 on DADE/BWD tabs (light green).
- 2) Devoted.2027.xlsx + 2027-BPAG-FL.xlsx (same Devoted FL B-PAG family, 8/17/2026) — wrote/reconfirmed Miami-Dade & Broward Devoted PBPs incl. BWD CORE 037 full refresh.
- 3) DOCTORS_2027_Agent_Memo.docx (Sep 14) — rename/renumber + re-enrollment ops; benefit $ later filled from AEP kickoff rollout slides 2026-09-15 (see below).
- 4) 2027_Elevance_Health_Early_Looks.pdf — FL strategy/highlights only (HealthSun/Simply/Optimum/Freedom); no PBP-level $ for grid columns.
- 5) HealthSpring_2027_First_Looks_091126.pdf — FL featured plans for North/Central/Tampa/Orlando/Daytona ONLY; NO Miami-Dade/Broward / NO H5410-060 or H5410-056.

## How to refresh

```bash
curl -sL -o /tmp/thei-2027-grid.xlsx 'https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/export?format=xlsx'
python3 scripts/export_2027_grid_to_kb.py
```
