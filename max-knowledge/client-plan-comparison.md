# Client-Facing Plan Comparison

Workflow for Max when an agent needs a **client-sendable** Medicare Advantage comparison that mirrors Yahoska’s **THEI client Google Sheet** (one tab per client).

**Last updated:** 2026-09-15

Use `search_knowledge` with queries like “client plan comparison”, “client-facing sheet”, “THEI client sheet”, “Carol.Wong”, or “comparison PDF” to retrieve this doc.

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

## Output layout (must mirror the sheet)

### 1. Client full name (first)

- Ask for the client’s **full name** if missing (this is the tab/header name).
- **Never invent** a name. **Never** use “Client”.
- Do not build a titled client sheet until the name is known.

### 2. Plan columns

- Shortlist **2–4** plans as columns: **carrier + plan name + plan ID**.
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

- Each row: **doctor name (+ specialty)** with **True/False** or **Yes/No** under each plan column (in-network?).
- Call `lookup_provider_network` for **each** known doctor with the **client ZIP**.
- If doctors unknown: ask agent to pull from the THEI sheet for that client, or: *“Do they have doctors or meds on our sheet / that we should check?”*
- Never invent doctors.

### 5. Rx rows

- Each row: **drug name** with **cost/copay under each plan** when known.
- Call `search_drug`; give formulary-oriented guidance.
- Clearly note **what Max verified** vs **what the agent must confirm** on the plan formulary (tier, PA, QL, pharmacy).
- If meds unknown: same ask as doctors / pull from sheet. Never invent meds.

### 6. TPMO / disclaimer

- No “best”, “closest”, “highest”, or plan recommendations on the client sheet.
- Brief disclaimer: benefits/network/formulary can change; agent re-confirms before enrollment; informational comparison only.

---

## Workflow checklist

1. Full name known (or asked) — never invent / never “Client”
2. Drs/Rx from conversation, paste, or THEI sheet tab for that client (URL above) — ask agent to pull if Max has no live access
3. Plan columns: carrier + name + plan ID (2–4) + ZIP/county
4. Benefit rows from SOB / Plan Compare / grid only
5. Doctor rows: True/False per plan via `lookup_provider_network`
6. Rx rows: cost/copay when known via `search_drug` + formulary caveats
7. No ranking language + short disclaimer
