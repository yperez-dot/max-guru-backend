# Max v12 — Full Client Export Handoff for Claude

## What Yahoska Wants

Yahoska showed two real-world examples of the Excel exports she manually creates today for clients. This is the target format Max needs to match.

### Her Current Export Format (the bar to hit):

**Example 1 — Carol Wong (PPO comparison):**
- 3 plans: AARP UHC Regional PPO, FL Blue Value PPO, Humana Full Access Giveback
- 8 doctors listed at top with ✅/❌ per plan (IN/OUT network)
- Full benefits grid (premium, MOOP, inpatient, copays, dental breakdown, tiers, OTC...)
- IN/OUT columns for PPO plans
- Summary of Benefits as clickable hyperlinks
- Multiple client tabs (Carol.Wong, Bonnie.Lane.PPO)

**Example 2 — Maritza Paredes (with drugs + C-SNP):**
- Doctors section with network checkmarks per plan
- Drugs section (each drug listed + cost per plan tier)
- Chronic Conditions section
- Full benefits grid

---

## What Max Can Do Today (v10)

✅ Export plan benefits grid (premium, MOOP, copays, dental, tiers, etc.)
✅ Live provider lookup (NPI + FHIR + Sunfire) — "Dr. Gilda is in-network for CarePlus"
✅ SOB links as clickable hyperlinks (v10)
❌ Doctor network section in the export (✅/❌ per plan per doctor)
❌ Drug cost section in the export
❌ Multiple client tabs
❌ IN/OUT columns for PPO plans

---

## v11 (Quick fixes — already discussed)

1. **SOB hyperlinks** — may already be done in v10, confirm
2. **Doctor network row in export** — after a provider lookup, add a "Doctors" section at top of Excel showing which plans each doctor is in-network for

## v12 (Full client workup export)

The goal: agent does a full consultation with Max (doctors, drugs, plans), then clicks Export and gets a complete client-ready Excel matching Yahoska's format.

### Required components:

**1. Doctors section (top of sheet)**
```
Doctor Name    | Plan A | Plan B | Plan C
Dr. Gilda      |   ✅   |   ✅   |   ❌
Dr. Tharkur    |   ❌   |   ❌   |   ✅
```
Data source: `lookup_provider_network` tool (already live)

**2. Drugs section**
```
Drug           | Plan A      | Plan B      | Plan C
Metformin HCL  | Tier 2 $10  | Tier 1 $5   | Tier 2 $12
Lisinopril     | Tier 1 $5   | Tier 1 $0   | Tier 1 $5
```
Data source: Formulary FHIR APIs (next build — not yet implemented)

**3. Plan benefits grid** (already in v10)

**4. Multiple client tabs** — name tabs after client (Carol.Wong, etc.)

**5. IN/OUT columns** — for PPO plans, split copay columns into In-Network / Out-of-Network

---

## How to Make This Work in Max's Chat Flow

Right now Max responds to questions one at a time. For a full client workup export, agents need a way to:

1. Tell Max the client's doctors ("My client sees Dr. Gilda and Dr. Tharkur")
2. Tell Max the client's drugs ("She takes metformin and lisinopril")
3. Ask for the comparison ("Compare Humana Gold Plus, Solis, CarePlus for her")
4. Click Export → gets the full Excel with doctors + drugs + plan grid

**Suggestion:** Add a "Start Client Workup" flow where Max collects all this in sequence, builds it up, then offers the export at the end.

---

## Technical Notes for Claude

- Provider lookup: `lookup_provider_network` tool in `services/claude.js` — already works
- Drug cost by plan: NOT YET BUILT — requires formulary FHIR APIs (HealthSun works, others pending)
- Export function: `exportComparison()` in the frontend HTML — Claude owns this
- Railway backend: push to `yperez-dot/max-guru-backend` (fork remote) — NOT `igor-thei/max-guru-backend`
- Current live version: v10 (Excel export restored + formatting bugs fixed)

---

## Priority Order

1. ✅ v10 done (export working, SOB links, formatting)
2. **v11** — Doctor network row in export (quick, data already available)
3. **v12** — Full client workup export (bigger lift, needs formulary data for drugs)

---

*Created: July 17, 2026 | By: Igor*
