# Root causes — comparison bugs 11.22.2026

Plain-English map of why this class of bugs kept happening, and the guard that now blocks each group. No PHI.

## Reply parsing (Bug 15)

**What happened.** After Max listed two “Luis Mendez” candidates, every agent reply was saved as a *new doctor name*. Nested prompts followed (`X = Y = Dr. Full Name`).

**Why.** `candidatePicks` only accepted ordinals, dentist/PA, an exact 10-digit NPI, or a unique name-shape match. Two people who share first+last tied, so it picked nothing. Then `statementsFor` dumped the entire reply as the replacement name whenever one doctor was asked, and `workupDoctorFixes` wrote `who.name = part`.

**Guard.** One resolver: `candidatePicks` scores specialty, city, credential, partial NPI, name mentions, and “yes”. MD alone is not enough to pick a listed candidate (it is too common). After a “No exact match” prompt, descriptive replies (“IS the Ob/Gyn…”) are never stored as names. A real First Last (or “X = listed candidate”) still binds to the asked doctor.

## Directory lookup reported as Out (Bugs 1 / 7)

**What happened.** Every doctor on the client’s current Devoted H1290-062 showed “Not in network (not listed)” even though they are on that plan.

**Why.** Devoted FHIR often returns PractitionerRole rows with no PDex `network-reference`. `devotedPlanVerdicts` treated an empty ref list as “not listed at all” and painted **every** 2027 Devoted plan Out. Chat columns then preferred those Out labels over the carrier hit.

**Guard.** Empty refs + a carrier listing → `unmapped` (not confirmed), never mass Out. Refs also read `.organization` and included Organization names (`FL HMO`). Devoted is no longer treated as a single network: In requires that plan’s own network.

## Plan-list mutation (Bug 17)

**What happened.** “Remove HealthSun HealthAdvantage · H5431-001” also dropped Aetna and Doctors. Remaining Prolia cells flipped because the other columns were re-priced.

**Why.** Several pipelines mutated the working set (carrier prefixes, including a bare `doctors?` regex that could match unrelated text, plus re-ranking after a drop). Removal was not “new list = old list minus named IDs”.

**Guard.** `removeNamedPlans` / `keepPlanColumns` are immutable: drop only the named contract-PBP, keep other columns’ doctor and med cells. Carrier prefix `H4140` only matches “Doctors HealthCare / DrMax / DrSelect”, not the word “doctor”. When a message names an H-number, that ID is the only drop.

## Network status semantics (Bugs 9–10, 4)

**What happened.** A doctor who is **out of network at this location** (Aetna banner) showed In*. HealthSun people stayed “not confirmed”; Max still claimed In somewhere.

**Why.** `isInNetworkStatus` treated any string containing a loose “in network” pattern as In, and a carrier-level hit became In* even when the compared plan was missing or the chosen office was OON. There was no status type that *forbids* In without a listing for **that** plan at **that** location.

**Guard.** `services/networkStatus.js` — In only with a plan-level listing and no location OON banner. OON banner → Out. Carrier hit without a plan row → not confirmed, never In*. Aetna network objects now carry `plans`, `outOfNetworkPlans`, and `locationOon`.

## Workup persistence (Bug 11)

**What happened.** Reopening a saved workup showed only the facts card. Checks restarted from 0; Medicaid / C-SNP / must-keep answers were gone.

**Why.** `openWorkup` preferred leftover `max_ws_v1` stage (`questions` / `running`) over `workup.compareResult`.

**Guard.** `restoreWorkspaceFromWorkup`: a finished `compareResult` wins unless a job is actually still queued/running. Eligibility answers are rehydrated onto the card.

## Med normalization (Bugs 2, 5, 14)

**What happened.** `24 HR oxcarbazepine 600 MG ER` became “hr oxcarbazepine extended release 24”. `0.00025 MG/MG` lost its strength. Estradiol gel vanished; the patch merged into an auto-corrected row. Diclofenac 20 MG/ML topical solution was “corrected” to diclofenac potassium.

**Why.** Strength parsing treated unitless `24` as a dose and left `hr` as the ingredient. `sameCoreDrug` skipped form/salt words, so topical solution ≈ potassium tablet. Dedupe keys were the **first token** (`estradiol`), so gel and patch collapsed.

**Guard.** Strength requires a unit (`mg`, `%`, `mg/ml`, `mg/hr`); `24 HR` is release, not dose; `mg/mg` becomes percent. Identity key is ingredient + form + strength. Non-oral forms never auto-correct onto a different product. Every entered med keeps its own row.

## Business suffix / pharmacy match (Bug 13)

**What happened.** “Cepero Eyecare Center, Inc” split on the comma. “Inc” matched a pharmacy.

**Why.** `splitList` split on every comma. Org search for leftover “Inc” (stop-word stripped) still queried NPPES. Pharmacy taxonomy was allowed on a doctor list.

**Guard.** Do not split before Inc/LLC/PA/MD/OD. Do not search orgs whose remaining tokens are shorter than 4 letters. Doctor-list NPPES results drop pharmacy records unless the agent asked for a pharmacy.

## Removal wording (Bug 16)

**What happened.** Removing a pharmacist row answered both “Couldn’t find… nothing removed” and “is removed”.

**Why.** Plan-removal and doctor-removal both ran. Grid suffix `· Pharmacist · NPI …` was not stripped, so the plan matcher missed and the doctor matcher hit.

**Guard.** A remove that names NPI / Pharmacist / “Dr. X” is a doctor removal only. Suffix is stripped. `doctorRemovalLines` returns **one** sentence.

## Output formatting (Bug 12)

**What happened.** Chat showed `T4 $30`; Excel/PDF showed `Tier 5 · 33%` (or `Tier 2 · $0`). Prolia on HealthSun H5431-001 disagreed across outputs.

**Why.** Two formatters. Export rebuilt cells from the grid’s T5 copay when it did not trust the lookup. HealthSun’s 2027 formulary book has **no Prolia/denosumab row**, so neither chat `T4 $30` nor export `T5 33%` is in the book. The lookup status is the only allowed source; with no row that status is unverified → **Confirm**, never a grid-tier copay guess.

**Guard.** One `formatMedCell` for chat, Excel, and PDF: `T# $X` or `T# X%` (single spaces), `Not covered`, or `Confirm`. A test fails if any med cell contains `Tier` or `·`. Both outputs read the same lookup status.

## Must-keep wording and counts (Bugs 3, 6)

**What happened.** Max said a must-keep doctor was “not confirmed on any of the four plans” when three cells were Out. Aetna’s summary said “1 unchecked” with no ❔ cell.

**Why.** `planLine` lumped Out with “unchecked/not confirmed”. `cellCountText` counted In* as unchecked because it did not subtract the star cells.

**Guard.** Plan lines name Not in network / not confirmed / unchecked separately. Count row subtracts In*. If a must-keep doctor is Out on checked plans and In on none, Max says so and offers to search other 2027 plans where they **are** in network.

## Exports (NPI + missing rows)

**What happened.** Excel/PDF printed doctor NPIs. Chiropractic, Other, Medical Deductible, and SSBCI Chronic Conditions were missing.

**Guard.** `doctorExportLabel` is name + specialty only. Those four rows are in `FIELD_ROWS` / `BENEFIT_ROWS` (values from plan/grid data, `—` when empty). Frontend HTML inlines `comparison-export.js`; both copies are synced.
