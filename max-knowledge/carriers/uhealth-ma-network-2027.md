# University of Miami / UHealth 2027 Medicare Advantage network

**2027 only.** Grid is the source of truth. UM's public page is extra detail only.

## THEI 2027 Plan Comparison Grid — Hospitals x Carrier tab

Workbook: https://docs.google.com/spreadsheets/d/1Vz9XBPwTO3a7181otdTf_NFkZFCXK4OT8O05ooeB0xg/edit?gid=369609513  
Pulled: 11.02.2026. Full matrix: `data/hospitals-x-carrier-2027.json` / `carriers/hospital-networks-2027`.

Do not confuse **UM PCP** (primary care) with **University of Miami** (hospital).

### UM PCP (primary care)

- **Yes:** HealthSun, Simply
- **No:** AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Solis, WellCare, UHC Dual Complete

So: HealthSun MediMax (H5431-006) and the other HealthSun 2027 Dade/Broward plans — UM PCP **Yes**. Simply Complete Platinum (H5471-125) — UM PCP **Yes**. Humana Gold Plus (H1036-054C / 065C) — UM PCP **No**. Aetna Medicare Select (H1609-093 / 018) — UM PCP **No**.

### University of Miami hospital (not PCP)

- **Yes:** HealthSun, Humana, Simply
- **No:** everyone else on the tab, including MedicareMax

Humana has the UM *hospital* (and, on UM's site, specialty / UMHC) but **not** UM primary care.

### Baptist rows (same tab — not UM)

- **Baptist PCPs:** Yes for FL BLUE and MedicareMax only.
- **Baptist Hospital:** separate hospital row. A Humana member can have Baptist Hospital and still have **no** Baptist PCP.

## Extra carriers from UHealth's site (no grid column)

Source: https://umiamihealth.org/en/billing-,-a-,-financial-information/insurance-plans-accepted  
Fetched: 11.02.2026, tab Health Plan - 2027. Label these as from UM's site, never as the THEI grid.

- **Prominence** (Palm Beach): UM PCP Yes; specialty Yes; hospital Yes. Plans: Prominence Plus, Giveback, Diabetes and Heart Giveback, Dual, Extra Help, Meridian. Palm Beach is not on the THEI grid.
- **Freedom** (Broward, Palm Beach): UM PCP No; specialty Yes; hospital Yes.
- **Optimum** (Broward, Palm Beach): UM PCP No; specialty Yes; hospital Yes.

The grid has no UM Specialty row. Humana specialty Yes is from UM's site and agrees with the grid (UM PCP No / hospital Yes).

## UM-listed plans with no 2027 THEI grid match

Do not invent a contract-PBP for these:

- Humana USAA Honor Giveback (HMO) — Miami-Dade / Broward / Palm Beach
- Humana Fully Integrated H1036-280 (HMO D-SNP)
- Humana Gold Plus H1036-062C — Palm Beach
- Simply Complete Platinum — Palm Beach (Dade/Broward matched H5471-125)
- HealthSun plans in Palm Beach (VitalCare, HealthAdvantage, HealthAdvantage Plus, MediSun Extra, MediSun Full Dual Extra)

2026 UM / Bascom Palmer notes stay in `hospital-networks` (2026 table). Do not copy 2027 PCP rows into a 2026 answer.
