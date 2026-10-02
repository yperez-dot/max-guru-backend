# HealthSpring / Cigna — no 2027 MA in Miami-Dade or Broward

Source: CMS CY2027 landscape + THEI Plan Comparison Grid (HealthSpring columns removed).  
Authoritative for THEI: **2026-10-02**.

**Hard fact:** HealthSpring (Cigna) has **no** 2027 Medicare Advantage plans in **Miami-Dade** or **Broward**. There is no HealthSpring plan to enroll into in those counties for plan year 2027. That includes the 2026 South Florida PBPs **H5410-060** (Preferred) and **H5410-056** (TotalCare D-SNP).

## What Max must say

- Agent asks HealthSpring / Cigna / H5410 for Miami-Dade or Broward **2027:** say there is **no HealthSpring 2027 MA plan** in that county. Do not list 2026 Preferred / TotalCare as a 2027 option.
- Do **not** quote 2026 HealthSpring dollar amounts (`carriers/healthspring-plans-florida-2026`) as 2027 benefits.
- Live doctor lookup may still return a **Cigna / HealthSpring** FHIR directory hit. That is a directory fact only. It does **not** mean “she’s in-network with Cigna so consider HealthSpring” for a 2027 Miami-Dade or Broward enrollment.
- Leftover yellow / workbook cells that still mention HealthSpring or Cigna on Dade or Broward 2027 tabs are **stale**. Ignore them for recommendations and do not import them as 2027 dollars.

## Where HealthSpring 2027 does exist

HealthSpring’s 2027 first-look featured Florida plans (North / Central / Tampa / Orlando / Daytona). Those are **outside** THEI’s Miami-Dade / Broward book. Do not treat them as a South Florida 2027 MA option. See the NOTES tab note on `carriers/plan-grid-overview-2027`.

## 2026 (current year only)

2026 Miami-Dade / Broward HealthSpring dollars stay in `carriers/healthspring-plans-florida-2026` and live `#plan-data`. Use those only when the agent is asking about **2026** coverage.
