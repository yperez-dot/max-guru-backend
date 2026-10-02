# Provider lookup — live vs manual (2026–2027)

Source: live API probes 2026-09-02 and UHC guest Find a Doctor 2026-10-02. For broker use when an agent asks if a doctor is in-network.

Max runs the CMS NPI Registry first. A failed or empty carrier check is not proof the provider is out of network **unless that carrier’s live directory returned a successful empty result for that plan**. Network participation is a fact, never a ranking signal.

**These three are not on THEI’s Sunfire provider search.** Do not treat a Sunfire miss as “not in Doctors / Solis / HealthSun.”

## HealthSun (H5431)

Live directory is FHIR (Aaneel), not Sunfire.

- Base: `https://api.aaneelconnect.com/cms/r4/providerdirectory`
- Query must include `payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95` or the server returns 500
- Max `/provider-lookup` and `lookup_provider_network` query this when this code is deployed
- Empty result = not in the HealthSun directory for that NPI

Member-facing directory: https://healthsun.com/provider-directory/

## Doctors HealthCare Plans (H4140)

No public FHIR. Live search is https://providersearch.doctorshcp.com (POST `/ProviderSearch` by NPI, PCP + specialist). Max queries this the same way. A hit means the NPI is in the Doctors directory — the API does not name a CMS plan ID (DrMax / DrSelect / DrElite share the directory).

Older SoB link https://www.doctorshcp.com/2026Providers/ still works for humans.

## Solis Health Plans (H0982)

No live provider API. The find-a-provider page is a placeholder; directories are county PDFs:

- Miami-Dade: https://soliscdrapi.azurewebsites.net/doc/ProvDirecMD_All_Current
- Broward & Palm Beach: https://soliscdrapi.azurewebsites.net/doc/ProvDirecBDPB_All_Current
- Central Florida: https://soliscdrapi.azurewebsites.net/doc/ProvDirecCFL_All_Current
- Hub page: https://solishealthplans.com/2026/find-a-provider

When an agent asks about Solis + a doctor, say Max cannot search Solis live and point them at the county PDF. Do not invent an in-network / out-of-network answer from training.

## NPI search (all carriers)

If the agent pastes a 10-digit NPI, Max looks that number up first. Name + ZIP is not enough: CMS ZIP is a hard filter (33166 hits a different Lazaro Garcia NP and misses Family Medicine MD `1598792707` at 33125 / Salus Health). Devoted’s public directory (PCP ID `LX358W-AA`) matches FHIR when queried by NPI; `_include=PractitionerRole:network` 400s on Devoted and must not be treated as “not in network.”

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
- Empty or expired Sunfire is **not** UHC out of network. Sunfire is secondary (Humana / Wellcare / CarePlus).

## Still Sunfire / carrier site

- **Humana:** public FHIR is WAF 403; no stable unauthenticated API is wired.
- **CarePlus, Wellcare:** no stable unauthenticated public provider API is wired.

Use THEI Sunfire when its session is available; otherwise the carrier's public directory. Do not invent an affiliation.
