# Michael Muskat 2027 comparison (Yahoska locked)

Source: Yahoska / THEI — locked Excel/PDF content for **Michael Muskat**, ZIP **33176**, plan year **2027**.  
Pulled: 2026-10-02

Not a ranking. Facts only. Export layout (Yahoska 2026-10-02): client title → plan headers → **Doctors first** → **Medications** (brand* not covered + generic) → 2027 green-cell benefits → SOB/EOC. **No Plan Terminating** (that row is only when she says a current plan is ending).

**This 014 snapshot is not a forever lock.** If a later Muskat thread cites different PBPs (stay-put MedicareMax FL-0028 **H5420-001**), Excel/PDF must use **that** comparison — plans, doctors (including Jason Margolesky and Miami Neurology & Rehab), live formulary, and 001 green cells. Never overwrite with this sheet. Never invent Plan Terminating from “no MSP row” / “do not add a Plan Terminating row.” Do not print that MSP sentence on the sheet. Verified In network on UHC **H5420-001** stays In network — a later miss or failed guest session is not Not confirmed.

**Humana stays first.** If the current comparison still includes Gold Plus **H1036-054C**, it is column 1 even when a later reply only restates 023 and 001. **One column per contract-PBP** — never two Doctors H4140-023 columns or two UHC H5420-001 columns. Keep verified thread Rx; do not blank them to Unverified. Keep Lipitor*/Atorvastatin and Benicar*/Olmesartan. One row per doctor: merge NPI legal name with the short name; keep In/Out; do not print a duplicate Not confirmed row.

## Plan columns (do not substitute)

| Column | Plan | CMS ID |
|--------|------|--------|
| Humana | Humana Gold Plus (core) | **H1036-054C** — not Giveback H1036-305 |
| Doctors | Doctors DrSelect-SFL | **H4140-023** — not H4140-012 |
| UHC | MedicareMax Complete Care | **H5420-014** (C-SNP: diabetes, CHF, and/or a cardiovascular disorder) |

Benefit dollars come from 2027 green cells on those IDs (live `#plan-data`). Highlights she cited: H1036-054C $0 prem / $9.30 Part B giveback / MOOP $500 / specialist $0 / dental $6,000 / OTC $110/mo Healthy Options; H4140-023 $0 prem / no giveback / MOOP $3,000 / specialist $0 / OTC $143/mo / unlimited trips; H5420-014 $0 prem / $61 Part B giveback / MOOP $3,400 / specialist $0 / dental $0 preventive & comprehensive / OTC Not Covered.

## Doctors (exact In/Out)

| Doctor | H1036-054C | H4140-023 | H5420-014 |
|--------|------------|-----------|-----------|
| Dr. Alejandro Roca | Out of network | In network | In network |
| Dr. Charles J. Kaiser | Out of network | In network | In network |
| Dr. William Trattler | Out of network | In network | In network |
| Dr. Neeta Jane Erinjeri | In network | In network | In network |

Always include this Doctors section on the Muskat export. Wire statuses into the export payload — do not omit the block.

## Medications (Yahoska verified 2027 — do not invent tiers)

Header note: `*Brand not covered — these three plans cover the generic only.`

Max must **automatically** pull Lipitor → Atorvastatin and Benicar → Olmesartan. Do not wait for Yahoska to type the generic. Locked cells below are Yahoska-verified 2027 facts. For any other client, generic tiers come from live `lookup_formulary` only — never invent a tier.

| Drug | H1036-054C | H4140-023 | H5420-014 |
|------|------------|-----------|-----------|
| Lipitor* | Not covered | Not covered | Not covered |
| Atorvastatin (generic) | Tier 1 · $0 | Tier 1 · $0 | Tier 1 · $0 |
| Benicar* | Not covered | Not covered | Not covered |
| Olmesartan (generic) | Tier 1 · $0 | Tier 1 · $0 | Tier 1 · $0 |
| Lorazepam | Tier 4 · 40% | Tier 1 · $0 | Tier 2 · $0 |
| Gabapentin | Tier 2 · $0 | Tier 1 · $0 | Tier 2 · $0 |
| Trintellix | Tier 4 · 40% | Tier 4 · $55 | Tier 3 · $0 |
| Memantine | Tier 2 · $0 | Tier 2 · $0 | Tier 2 · $0 |

Never print carrier names (Doctors, UHC, Humana) as medication rows.
