# Provider lookup — Doctors, Solis, HealthSun (2026)

Source: live API probe 2026-09-02. For broker use when an agent asks if a doctor is in-network for **Doctors HealthCare Plans (H4140)**, **Solis (H0982)**, or **HealthSun (H5431)**.

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

## Aetna (H1609)

Guest search at https://www.aetna.com/medicare/find-provider.html (Continue as guest). No member login. Max uses the public SPA token + `ahpublic_taxonomy` / `ahpublic_search` / provider healthplans. A directory hit is not the same as Medicare Advantage in-network for that ZIP.

## Simply Healthcare (H5471)

Guest Find Care: https://findcare.simplyhealthcareplans.com/?brand=SHC and shop https://shop.simplyhealthcareplans.com/medicare/standalonetools/find-doctor?brand=SIMPLY. No member login. Max uses Find Care guest JWT (`meta-brandcd: SHC`) and search-box by last name, then matches NPI. If search-box times out, say so and hand the agent the guest URL — do not invent Simply in- or out-of-network.
