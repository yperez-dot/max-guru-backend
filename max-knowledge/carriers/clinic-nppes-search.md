# Clinic / group NPPES search (when the person directory misses)

Source: Yahoska 2026-10-02. For broker use when an agent has a **clinic, group, or DBA** name that `lookup_provider_network` does not match as a person.

Max has `search_clinic_or_provider`: CMS NPPES **NPI-2** organization search (trailing wildcard, e.g. `MIAMI NEUROLOGY*`) plus an optional fetch of a **known clinic webpage** the agent already has. Do **not** scrape Google/Bing SERPs.

Then re-run `lookup_provider_network` with **npi=**. True In/Out is NPI + carrier Find Care / FHIR / guest directory only.

## Miami Neurology & Rehab Specialists / MNRS Physical Therapy

Informal name agents use: Miami Neurology & Rehab Specialists. DBA: **MNRS** / MNRS Physical Therapy.

| Field | Value |
|-------|--------|
| Legal NPPES name | MIAMI NEUROLOGY & REHABILITATION SPECIALISTS |
| Org NPI | **1689860280** (NPI-2) |
| South Miami | 5975 Sunset Dr #405, 33143 — 305-661-8040 |
| Kendall | 11440 N Kendall Dr #101, 33176 — 305-459-5667 |
| Site | https://miamiphysicaltherapy.com/insurances/ |

NPPES `other_names` does **not** list MNRS. CMS exact `organization_name=MIAMI NEUROLOGY` (no `*`) returns 0.

## Insurances-accepted pages are marketing, not network status

Yahoska confirmed the MNRS insurances page logos (filenames, alts are often just “client”): **Aetna, ASHP, AvMed, Cigna, Doctors Healthcare, GEHA, Golden Rule, Hartford, Harvard Pilgrim, Medicare, NALC, PHCS, TRICARE, UnitedHealthcare, UAIC, UMR, VA, Gallagher Bassett.** **No Humana.**

If a Humana (or other carrier) logo **is** on the clinic site, Max may say: “Found a Humana logo on their site — here's the link. I recommend you call and confirm.” Never treat that as verified In-network.

If the agent is checking **Humana** (Muskats) and Humana is **not** listed: say Humana is not listed on their accepted-insurances page, **link it**, and recommend calling the office to confirm. Do **not** treat absence on the clinic site as definitive out-of-network if Find Care later returns in-network. Prefer reporting **both**: not listed on clinic site **and** the NPI Find Care result.
