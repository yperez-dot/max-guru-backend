# Client-Facing Plan Comparison

Workflow for Max when an agent needs a **client-sendable** Medicare Advantage comparison.

**Preferred export look (Yahoska):** Match the **Arias Lazo** Excel/PDF — client name as the title, optional Plan Terminating row, plan columns as full marketing name + contract-PBP on its own line, **Doctors** (`In network` / `Out of network`) before benefits, then the fixed benefit row order, SOB/EOC as links or pending. **No** ranking blurbs (“closest”, “highest giveback”, “best for”).

**Data workflow:** Still mirror Yahoska’s **THEI client Google Sheet** (one tab per client) for which plans, doctors, and Rx to include.

**Last updated:** 2026-10-02

Use `search_knowledge` with queries like “client plan comparison”, “Arias Lazo”, “Yahoska sheet”, “client-facing sheet”, “THEI client sheet”, “Carol.Wong”, or “comparison PDF” to retrieve this doc.

---

## THEI client Google Sheet

- **Sheet id:** `17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc`
- **URL (share with agents):** https://docs.google.com/spreadsheets/d/17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc/edit
- **Structure:** one tab per client (tab/header = client full name).
- Max **may not have live Google Sheets access**. If Drs/Rx are not already in the conversation or pasted: ask the agent to **pull doctors and medications from that sheet for the named client**.

### Example tabs (layout cues)

| Tab | What to mirror |
|-----|----------------|
| Sr. Perez | ZIP + medications |
| Carol.Wong | Doctor True/False columns, then benefit rows |
| Bonnie.Lane | Many specialists with True/False under each plan |

---

## When this applies

- Agent asks for a comparison the **client can see / be sent** (sheet-style or PDF-style).
- Out-of-area counties **or** Miami-Dade / Broward when a clean client-facing table is requested.

---

## Preferred Excel / PDF export (Yahoska / Arias Lazo)

The live UI **Export Excel** and **Export PDF** buttons build this layout from grid plan objects plus thread facts (client name, terminating plan, doctor in/out). Chat replies stay short bullets — do not paste a markdown table.

1. **Title:** client full name (ask if missing; never invent; never “Client”).
2. **Plan Terminating** only if the agent explicitly says a current plan is ending. Not part of the standard template (Arias had one because that client’s plan was terminating).
3. **Plan columns:** full marketing name, contract-PBP on the next line (`H1045-012`). Not `Carrier — Plan (id) county`.
4. **Doctors** first whenever providers were checked or named: `In network` / `Out of network` / `Not confirmed` / `Need more info` per plan. Call `lookup_provider_network` and wire results into the export payload so the section is not skipped.
5. **Benefit rows** in this order, sourced cells only (gaps = `Not listed` / `N/A` / `SOB pending` / `EOC pending`): Premium; Part B Rebate; Referrals Needed?; MSP Levels; Max Out of Pocket; Inpatient Hospital; Outpatient Hospital; PCP; Specialist; ER; Urgent Care; Advanced Imaging (MRI, CT, PET); Hearing Services; Dental; Deep Cleaning; Dentures; Fillings; Root Canals; Extractions; Crowns; Bridges; Implants; Vision Allowance; Ambulance; Transportation; Companionship; Custodial Care; RX Deductible; Tier 1–6; OTC; Grocery Card; Acupuncture; Fitness; Summary of Benefits; Evidence of Coverage.
6. SOB/EOC: clickable hyperlink when the URL is on the plan; otherwise pending.

Filename includes the client name when known.

## Output layout (must mirror the sheet)

### 1. Client full name (first)

- Ask for the client’s **full name** if missing (this is the tab/header name).
- **Never invent** a name. **Never** use “Client”.
- Do not build a titled client sheet until the name is known.

### 2. Plan columns

- Shortlist **2–4** plans as columns: **marketing name + contract-PBP** (CMS ID on its own line).
- Include **ZIP / county** in the header area.
- **Out-of-area:** call `discover_similar_plans` + medicare.gov **Plan Compare** (+ SOB). Say when THEI grid does not cover the county.
- **Miami-Dade / Broward:** THEI **PLAN DATA / grid** when relevant; still cite SOB / Plan Compare as needed.
- **Do not invent** benefit dollars.

### 3. Benefit rows

Objective rows only (adapt to sourced data), for example:

- Monthly premium
- Referrals required?
- Part B giveback
- MOOP
- Hospital / inpatient
- PCP
- Specialist
- Other extras only when sourced (dental, vision, OTC, etc.)

**Sources:** SOB / Plan Compare / THEI grid. No ranking language.

### 4. Doctor rows

- Each row: **doctor name (+ specialty)** with **In network / Out of network** under each plan column.
- Call `lookup_provider_network` for **each** known doctor with the **client ZIP**.
- If doctors unknown: ask agent to pull from the THEI sheet for that client, or: *“Do they have doctors or meds on our sheet / that we should check?”*
- Never invent doctors.

### 5. Rx / Medications rows

- Each row: **drug name** with **verified formulary tier + T1–T6 cost-share** under each plan.
- Call `lookup_formulary` for **each drug × each named plan** (year 2027 unless asked otherwise). `search_drug` is catalog/NDC only — it does **not** verify a tier. Chain: Sunfire → Humana FHIR → medicare.gov → Doctors 2027 formulary PDF for H4140 (001→022, 012→023).
- A pasted “Tier X” (Daisy, client claim, last year, or a finished-comp archive) is **discarded**. Keep drug names only. Never copy, quote, or imply that label.
- When a **brand is verified not covered**, automatically pull / suggest the generic (Lipitor → Atorvastatin, Benicar → Olmesartan). Do **not** wait for the agent to type the generic. Show the brand as `Brand*` + the asterisk note. Generic tier comes from that live follow-up only — never invent a tier. If the generic lookup fails, the generic row is **Unverified**.
- If lookup fails: cell is **Unverified**. Do not fall back to Daisy’s number.
- After a verified tier, cost-share comes from THEI 2027 Hub/grid T1–T6 columns — not from the paste.
- Yahoska’s finished-comp archive (`1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A`) is **not** a formulary or 2027 benefit-grid source. The in-progress client Drs/Rx sheet remains `17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc`.
- If meds unknown: same ask as doctors / pull from the working client sheet. Never invent meds.

### 6. TPMO / disclaimer

- No “best”, “closest”, “highest”, or plan recommendations on the client sheet.
- Brief disclaimer: benefits/network/formulary can change; agent re-confirms before enrollment; informational comparison only.

---

## Workflow checklist

1. Full name known (or asked) — never invent / never “Client”
2. Drs/Rx from conversation, paste, or THEI sheet tab for that client (URL above) — ask agent to pull if Max has no live access
3. Plan columns: carrier + name + plan ID (2–4) + ZIP/county
4. Benefit rows from SOB / Plan Compare / grid only
5. Doctor rows: In network / Out of network / Not confirmed / Need more info per plan via `lookup_provider_network` (always include the section when providers were checked or named)
6. Rx rows: verified tier + T1–T6 cost-share via `lookup_formulary` only (Unverified if lookup fails). Brand not covered → auto-suggest generic; never invent a generic tier.
7. No ranking language + short disclaimer
