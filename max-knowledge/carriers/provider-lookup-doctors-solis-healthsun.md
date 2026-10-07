# Provider lookup — live vs manual (2026–2027)

Source: live API probes 2026-09-02, UHC guest Find a Doctor 2026-10-02, and Humana Find Care guest 2026-10-02. For broker use when an agent asks if a doctor is in-network.

Max runs the CMS NPI Registry first. A failed or empty carrier check is not proof the provider is out of network **unless that carrier’s live directory returned a successful empty result for that plan**. Network participation is a fact, never a ranking signal.

**These three are not on THEI’s Sunfire provider search.** Do not treat a Sunfire miss as “not in Doctors / Solis / HealthSun.”

## HealthSun (H5431)

Live directory is FHIR (Aaneel), not Sunfire.

- Base: `https://api.aaneelconnect.com/cms/r4/providerdirectory`
- Query must include `payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95` or the server returns 500
- Max `/provider-lookup` and `lookup_provider_network` query this when this code is deployed
- Empty result = not in the HealthSun directory for that NPI

Member-facing directory: https://healthsun.com/provider-directory/

**2027 directory name index (2026-10-07).** The FHIR answer is carrier-level only, so Max also checks HealthSun's 2027 Provider and Pharmacy Directory PDF (Miami-Dade, Broward, Palm Beach; current as of Sep 4, 2026), indexed by name into `data/healthsun-directory-2027.json` (4,148 people). The PDF has NO NPIs, so it is a name match (surname + first name — "Rajdeep S. Gadh" never matches Dr. Rundeep Gadh). Listed in the client's county = In for HealthSun plans there, with the PDF page. Not listed = **not confirmed, never Out** (a name match can miss a real listing). No ZIP / county outside the three = unchecked. Rebuild with `scripts/build_healthsun_index.py` when HealthSun republishes.

## Doctors HealthCare Plans (H4140)

No public FHIR. Live search is https://providersearch.doctorshcp.com (POST `/ProviderSearch` by NPI, PCP + specialist). Max queries this the same way. A hit means the NPI is in the Doctors directory — the API does not name a CMS plan ID. DrMax-Dade (H4140-022) and DrSelect-SFL (H4140-023) share one network (Yahoska, 2026-10-06), so a hit counts as In for both. The API rejects bursts with HTTP 404 — Max searches one list at a time and retries.

2027 directory page for humans: https://www.doctorshcp.com/2027providers/ (the old `/2026Providers/` page returns 404).

## Solis Health Plans (H0982)

Not on Sunfire. **Max checks Solis itself (2026-10-06):** the 2027 county directory PDFs' alphabetical indexes are built into `data/solis-directory-2027.json` (Miami-Dade 1,827 · Broward & Palm Beach 2,246 · Central FL 3,790 providers, current as of Oct 1, 2026). Match is by name (first name + surname — the PDFs have no NPIs); a listed doctor shows the PDF page (e.g. Krajewski, Eduardo MD — Miami-Dade p. 93). Not listed in the client's county = Out; county unknown = unchecked. Rebuild monthly with `scripts/build_solis_index.py`. Solis's own live search API returned HTTP 500 on 2026-10-06. For humans:

- 2027 find-a-provider (live name / ZIP search, slow and sometimes erroring): https://solishealthplans.com/2027/find-a-provider
- 2027 Miami-Dade PDF: https://soliscdrapi.azurewebsites.net/doc/ProvDirecMD_All_Next
- 2027 Broward & Palm Beach PDF: https://soliscdrapi.azurewebsites.net/doc/ProvDirecBDPB_All_Next
- 2027 Central Florida PDF: https://soliscdrapi.azurewebsites.net/doc/ProvDirecCFL_All_Next
- 2026: same file names ending `_Current`; page https://solishealthplans.com/2026/find-a-provider

The PDF links start a download (Chrome can show a blank or error tab — check Downloads). When an agent asks about Solis + a doctor, use the lookup result (name match against the 2027 PDF index) and give the PDF page for a listed doctor. Do not invent an in-network / out-of-network answer from training.

## NPI search (all carriers)

If the agent pastes a 10-digit NPI, Max looks that number up first. Name + ZIP is not enough: CMS ZIP is a hard filter (33166 hits a different Lazaro Garcia NP and misses Family Medicine MD `1598792707` at 33125 / Salus Health). Devoted’s public directory (PCP ID `LX358W-AA`) matches FHIR when queried by NPI; `_include=PractitionerRole:network` 400s on Devoted and must not be treated as “not in network.”

## Clinic / group names (NPI-2)

Person last-name search misses clinics (e.g. Miami Neurology & Rehab Specialists). Use `search_clinic_or_provider` (NPPES org wildcard + optional known site). MNRS / MIAMI NEUROLOGY & REHABILITATION SPECIALISTS is org NPI `1689860280`. Details: `carriers/clinic-nppes-search`. Never invent In/Out from a clinic insurances-accepted page.

## Aetna (H1609)

Guest search at https://www.aetna.com/medicare/find-provider.html (Continue as guest). No member login. Max uses the public SPA token + `ahpublic_taxonomy` / `ahpublic_search` / provider healthplans. A directory hit is not the same as Medicare Advantage in-network for that ZIP.

## Simply Healthcare (H5471)

Guest Find Care: https://findcare.simplyhealthcareplans.com/?brand=SHC and shop https://shop.simplyhealthcareplans.com/medicare/standalonetools/find-doctor?brand=SIMPLY. No member login. Max uses Find Care guest JWT (`meta-brandcd: SHC`) and search-box by last name, then matches NPI. If search-box times out, say so and hand the agent the guest URL — do not invent Simply in- or out-of-network.

## UHC / Preferred / MedicareMax / AARP (H1045, H5420, H1889, R0759) — AEP 2027

**Public guest Find a Doctor only.** No Jarvis. No member login.

- Guest SPA: https://findcare.guest.uhc.com/guest-plan-selection/browse (Medicare deeplink). Landing page: https://www.uhc.com/find-a-doctor (Continue as guest).
- Max mints a guest session and searches 2027 plan definitions by NPI.
- THEI Duals: **H1045-012** Preferred Dual Complete FL-QV4, **H1045-061** FL-QV5, **H1045-063** FL-Y6 (Miami-Dade / Broward).
- Successful empty search for that CMS ID = out of network for **that plan**.
- Session / GraphQL failure = failed check. Hand the guest URL. Do not say out of network.
- Empty or expired Sunfire is **not** UHC or Humana out of network. Sunfire is secondary (Wellcare / CarePlus; Humana only if Find Care fails).

## Humana (H1036, H7617) — AEP 2027

**Public Find Care guest only.** No MyHumana / member login.

- Guest SPA: https://findcare.humana.com (Search as a guest). `www.humana.com/finder` redirects here.
- Max loads the public APIM subscription from `/session/v1/config`, mints a guest token, lists 2027 `future` Medicare networks for the ZIP, and searches by NPI (`POST /apim-gateway/api/v1/providersearch/npi/` — trailing slash required).
- THEI 2027 mapping is by **network**, not PBP: FL Medicare HMO27 (Gold Plus HMO/C-SNP/Giveback), HIDE HMO27 (Dual Select), FIDE HMO27 (Dual Integrated, Miami-Dade), Medicare PPO27 (HumanaChoice).
- Successful empty search for that network = out of network for **the THEI CMS IDs on that network**.
- Config / token / nginx failure = failed check. Hand the guest URL. Do not say out of network.
- Empty or expired Sunfire is **not** Humana out of network.

## Still Sunfire / carrier site

- **CarePlus, Wellcare:** no stable unauthenticated public provider API is wired.

Use THEI Sunfire when its session is available; otherwise the carrier's public directory. Do not invent an affiliation.

## Solis drug formulary (2027)

Solis is not on Sunfire and has no consumer formulary API. Max answers Solis drug tiers from `data/solis-formulary-2027.json`, built by `scripts/build_solis_formulary.py` from Solis's published Comprehensive Formulary PDF (H0982_formulary27_C, updated 10/05/2026). One tier per drug, plan-wide for every H0982 plan that year. A drug that is not in the book returns no tier — say unverified, never invent one. Rebuild when Solis republishes.
