# Hospital networks — 2027 (Florida)

Source: THEI 2027 Plan Comparison Grid — **Hospitals x Carrier** tab
Workbook: https://docs.google.com/spreadsheets/d/1Vz9XBPwTO3a7181otdTf_NFkZFCXK4OT8O05ooeB0xg/edit?gid=369609513
Pulled: 11.02.2026

This is the **2027** hospital × carrier Yes/No matrix. Live Max answers 2027 hospital and PCP-row questions from `data/hospitals-x-carrier-2027.json` (this tab). The 2026 table in `hospital-networks` is unchanged — use it only for a 2026-only ask.

**PCP vs hospital:** `Baptist PCPs` and `UM PCP` are primary-care rows. `Baptist Hospital` and `University of Miami` are hospital rows. Do not answer a PCP question from a hospital row, or a hospital question from a PCP row.

A cell that starts with **Yes** is in network. **No** is out. A blank cell is not on the grid — do not invent Yes or No.

Refresh: `python3 scripts/export_2027_hospitals.py` (same `/tmp/thei-2027-grid.xlsx` as the other 2027 grid exporters).

## PCP rows (2027)

### Baptist PCPs

- **Yes:** FL BLUE, MedicareMax
- **No:** AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete

### UM PCP

- **Yes:** HealthSun, Simply
- **No:** AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Solis, WellCare, UHC Dual Complete

## University of Miami hospital (not PCP)

- **Yes:** HealthSun, Humana, Simply
- Humana is **Yes** for the UM *hospital* and **No** on the UM PCP row (specialty + UMHC, no UM primary care).

## Extra carriers from UHealth's site (no grid column)

Source: https://umiamihealth.org/en/billing-,-a-,-financial-information/insurance-plans-accepted (fetched 11.02.2026, Health Plan - 2027). The grid has no column for these carriers. Label the answer as from UM's site. Never invent participation for a plan that is not in this file.

- **Prominence** (Palm Beach): UM PCP Yes; UM specialty Yes; UM hospital Yes. Plans: Prominence Plus (HMO); Prominence Giveback (HMO); Prominence Diabetes and Heart Giveback (HMO C-SNP); Prominence Dual (HMO D-SNP); Prominence Extra Help (HMO); Prominence Meridian (HMO-POS).
- **Freedom** (Broward, Palm Beach): UM PCP No; UM specialty Yes; UM hospital Yes. Plans: Freedom VIP Savings (HMO C-SNP); Freedom VIP Savings COPD (HMO C-SNP); Freedom Medi-Medi Partial (HMO D-SNP); Freedom VIP Care (HMO C-SNP); Freedom Savings Plan (HMO); Freedom Medicare Plan Rx (HMO).
- **Optimum** (Broward, Palm Beach): UM PCP No; UM specialty Yes; UM hospital Yes. Plans: Optimum Emerald Partial (HMO D-SNP); Optimum Platinum Plan (HMO); Optimum Gold Rewards Plan (HMO).

UM-listed plans with no 2027 THEI grid match (do not invent a contract-PBP):

- Humana USAA Honor Giveback (HMO) — no matching 2027 THEI grid plan in Miami-Dade/Broward
- Humana Fully Integrated H1036-280 (HMO D-SNP) — H1036-280 is not on the 2027 THEI Miami-Dade/Broward grid
- Humana Gold Plus H1036-062C (HMO) — Palm Beach is not on the THEI 2027 grid
- Simply Complete Platinum (HMO D-SNP) — Palm Beach is not on the THEI 2027 grid; Miami-Dade/Broward matched H5471-125
- HealthSun plans in Palm Beach (VitalCare, HealthAdvantage, HealthAdvantage Plus, MediSun Extra, MediSun Full Dual Extra) — Palm Beach is not on the THEI 2027 grid; HealthSun PCP Yes still comes from the grid HealthSun column for Dade/Broward

## Full lookup table

| Hospital | Kind | Carriers in-network (Yes) |
|----------|------|---------------------------|
| Aventura | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Baptist Hospital | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax |
| Baptist PCPs | pcp | FL BLUE, MedicareMax |
| Bascom Palmer | hospital | Aetna |
| Bethesda West | hospital | AARP/UHC Choice PPO, Aetna PPO, CarePlus, Humana PPO, Preferred Care Partner, WellCare, UHC Dual Complete |
| Broward Health | hospital | AARP/UHC Choice PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare |
| Broward Health (ALL) | hospital | AARP/UHC Choice PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare |
| Broward Health Coral Springs | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Broward Health Imperial Point | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Broward Health Medical Center | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Broward Health North | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Cleveland Clinic | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax, Preferred Care Partner, UHC Dual Complete |
| Coral Gables | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Coral Springs Medical Center | hospital | AARP/UHC Choice PPO, HealthSun, MedicareMax, Simply |
| Delray Medical | hospital | AARP/UHC Choice PPO, Aetna, CarePlus, Devoted HMO, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Doctors | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax |
| Douglas Gardens | hospital | FL BLUE |
| Emergency Mount Sinai | hospital | FL BLUE |
| Florida Medical Center | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Florida Medical Center Center | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, UHC Dual Complete |
| Fort Lauderdale Hosp | hospital | FL BLUE, WellCare |
| HCA Florida | hospital | FL BLUE, Humana PPO |
| HCA Florida Aventura | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| HCA Northwest | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| HCA Davie | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| HCA University | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| HCA Westside | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| HCA Woodmont | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| HealthSouth | hospital | WellCare |
| Henderson Behavioral | hospital | FL BLUE |
| Hialeah | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Holy Cross | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, UHC Dual Complete |
| Homestead | hospital | Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax |
| Jackson North | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Jackson South | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Jackson West | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, UHC Dual Complete |
| Kendall Regional | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, UHC Dual Complete |
| Kindred | hospital | CarePlus, FL BLUE, Humana, Humana PPO, MedicareMax, Simply, WellCare |
| Kindred FTL | hospital | CarePlus, Humana, Humana PPO, MedicareMax, Simply |
| Kindred Hollywood | hospital | Aetna, CarePlus, Humana, Humana PPO, MedicareMax, WellCare |
| Kindred Hospital | hospital | FL BLUE, Humana PPO, Simply, WellCare |
| Kindred Hospital of Coral Gables | hospital | CarePlus, FL BLUE, Humana, Humana PPO, MedicareMax, Simply, WellCare |
| Larkin | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare |
| Larkin Hollywood | hospital | AARP/UHC Choice PPO, CarePlus, MedicareMax, Preferred Care Partner, WellCare, UHC Dual Complete |
| LCH Palm Springs | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, UHC Dual Complete |
| Memorial Hospitals | hospital | AARP/UHC Choice PPO, Aetna, Doctors, HealthSun, Humana, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Memorial Miramar | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Doctors, HealthSun, Humana, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Memorial Pembroke | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Humana, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Memorial Regional | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Doctors, HealthSun, Humana, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Memorial West | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Doctors, HealthSun, Humana, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Mercy | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare |
| Mount Sinai | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, Devoted HMO, Doctors, FL BLUE, HealthSun, MedicareMax, Preferred Care Partner, Simply, UHC Dual Complete |
| North Shore | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, UHC Dual Complete |
| Northwest Medical | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Palm Springs | hospital | AARP/UHC Choice PPO, Aetna PPO, WellCare |
| Palmetto | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Plantation | hospital | AARP/UHC Choice PPO, Aetna, CarePlus, Devoted HMO, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| Promise | hospital | Aetna |
| Select Specialty | hospital | CarePlus, FL BLUE, Humana, Humana PPO, Simply, Solis, WellCare |
| Select Specialty Hospital | hospital | CarePlus, FL BLUE, Humana, Humana PPO, MedicareMax, Simply, Solis, WellCare |
| Solera | hospital | FL BLUE |
| South Broward | hospital | Solis |
| South Miami | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, MedicareMax, UHC Dual Complete |
| South Miami Baptist | hospital | Aetna PPO, CarePlus, Devoted HMO, Humana |
| St Catherines West Rehab | hospital | HealthSun, Humana, Humana PPO |
| St. Anthony Rehab | hospital | CarePlus, FL BLUE, Humana, Humana PPO |
| Steward | hospital | — |
| Steward Coral Gables | hospital | AARP/UHC Choice PPO, FL BLUE, Simply, Solis, WellCare |
| Steward Florida | hospital | FL BLUE |
| Steward Florida Medical Center | hospital | AARP/UHC Choice PPO, Simply |
| Steward Hialeah | hospital | AARP/UHC Choice PPO, HealthSun, Simply, Solis, WellCare |
| Steward Hialeah & North Shore | hospital | Doctors, Simply |
| Steward Medical Center | hospital | — |
| Steward Palmetto | hospital | AARP/UHC Choice PPO, Simply, WellCare |
| Trinity | hospital | Aetna |
| University of Miami | hospital | HealthSun, Humana, Simply |
| UM PCP | pcp | HealthSun, Simply |
| University Hospital | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Simply, WellCare, UHC Dual Complete |
| West Boca | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
| West Boca Medical | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, UHC Dual Complete |
| West Gables Rehab | hospital | CarePlus, HealthSun, Humana, Humana PPO, MedicareMax, Simply, Solis, WellCare |
| West Kendall Baptist | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, Humana, Humana PPO, MedicareMax |
| Keralty (Westchester) | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Westchester General (Keralty) | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Westchester Hospital (Keralty) | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, Solis, WellCare, UHC Dual Complete |
| Westside Regional | hospital | AARP/UHC Choice PPO, Aetna PPO, Aetna, CarePlus, Devoted HMO, Doctors, FL BLUE, HealthSun, Humana, Humana PPO, MedicareMax, Preferred Care Partner, Simply, WellCare, UHC Dual Complete |
