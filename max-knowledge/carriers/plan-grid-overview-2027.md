# 2027 THEI plan grid — what Max can cite
Source: THEI 2027 Plan Benefit Grid working copy ([Google Sheet](https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/edit))
Pulled: 2026-09-04 22:20 UTC
Sheet stamp: 2505 green / 3450 yellow benefit cells across plan tabs.

Color key on the sheet: **light green** = 2027 number from an official SoB, highlight, or sneak-peek slide (official SoB wins). **Yellow** = still the 2026 number. Max only cites green.

Live `#plan-data` stays the **2026** grid. These files are how chat answers 2027.

## Confirmed 2027 plan dollars (green)

| Carrier | Plans with confirmed 2027 cells | KB doc |
|---------|----------------------------------|--------|
| Humana | 21 | `carriers/humana-plans-florida-2027` |
| Devoted | 17 | `carriers/devoted-plans-florida-2027` |
| UHC | 18 | `carriers/uhc-plans-florida-2027` |
| CarePlus | 17 | `carriers/careplus-plans-florida-2027` |
| Aetna | 10 | `carriers/aetna-plans-florida-2027` |

## Still waiting on the official October 1 SoB

These carriers are on the 2027 workbook but every benefit cell is still yellow. Do **not** quote their 2026 leftover numbers as 2027. Say Max does not have that 2027 figure yet.

- Doctors
- Florida Blue
- HealthSpring / Cigna
- HealthSun
- Simply
- Solis
- Wellcare
- Gold Kidney

## New 2027 plans on the grid

- CarePlus CareFree Giveback (`H1019-065`) — Broward Giveback
- CarePlus CareBreeze (`H1019-154`) — Broward C-SNP
- CarePlus CareBreeze (`H1019-154`) — Miami-Dade C-SNP
- Devoted GIVEBACK EXTRAS (`H1290-110`) — Miami-Dade Giveback
- Aetna Medicare Partial Dual Select (`H1609-103`) — Broward D-SNP
- Aetna Medicare Partial Dual Select (`H1609-103`) — Miami-Dade D-SNP
- Humana Choice Giveback (`H7617-145`) — Broward PPO
- Humana Choice Giveback (`H7617-145`) — Miami-Dade PPO

## Closed to new enroll 2027

- UHC Dual Complete Choice PPO (`H1889-002`) — Broward
- UHC Dual Complete Choice PPO (`H1889-002`) — Miami-Dade
- UHC Dual Complete FL-Y4 PPO (`H1889-026`) — Broward
- UHC Dual Complete FL-Y4 PPO (`H1889-026`) — Miami-Dade

## Marked non-commissionable on the 2027 grid (new sales)

- AARP UHC Regional PPO FL-0031 (`R0759-001`)
- Humana Choice (`H7617-107`)
- Humana Choice Giveback (`H7617-110`)

## Hospital / network notes already confirmed for 2027

- **UHealth / University of Miami** and **Bascom Palmer** are **out of MedicareMax (Preferred Care Network)** as of **1/1/2027**. In-network through 12/31/2026. University Hospital on the Hospitals tab is HCA Davie — not UM.
- Other hospital Yes/— marks stay 2026 until a public 2027 directory lands (due Oct 1, 2026).

## Workbook notes (from the 2027 NOTES tab)

- 2027 Plan Benefit Grid — working copy
- The Health Experts Insurance · Doral, FL · 1-800-380-6821
- AEP October 15 – December 7, 2026 (for 2027 coverage)
- This file is a copy of the 2026 Google Sheet with 2027 numbers written on top.
- Do not File → Import this into the live 2026 workbook. Upload this file as a NEW Google Sheet.
- 2026 source: https://docs.google.com/spreadsheets/d/13qp5zQ5FqnoxxOrcfabW21i_O-TZr4hP2UPbEKxoUXA/edit
- Color key
- Yellow = still the 2026 number. Not confirmed from a 2027 SOB / sneak peek.
- Light green = 2027 number entered from an official SOB, highlight, or slide. Official SOB wins.
- Hospitals: 2026 Yes/— stays unless a public 2027 directory says otherwise (due Oct 1, 2026).
- UHealth / University of Miami and Bascom Palmer × MedicareMax are out 1/1/2027.
- University Hospital on the Hospitals tab is HCA Davie — not UM. Leave it.
- Skip Palm Beach-only PBPs. Do not write one dual onto a sibling.
- Upload to your Drive: drive.google.com → New → File upload → this xlsx → Open with Google Sheets.
- Columns with a 2027 status stamp: 75 confirmed, 10 new, 4 exiting.
- Yellow leftover columns still need the official October 1 SOB.

## How to refresh

```bash
curl -sL -o /tmp/thei-2027-grid.xlsx 'https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/export?format=xlsx'
python3 scripts/export_2027_grid_to_kb.py
```
