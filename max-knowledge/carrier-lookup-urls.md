# Carrier Provider & Drug Lookup URLs — 2026–2027
Last updated: 2026-10-06 (directory audit — 2027 links checked live)
Use these links when an agent needs to check if a provider is in-network or if a drug is covered.

> **Note:** Some tools require the member to log in for plan-specific results. Guest/public searches show general network info. Always confirm with the carrier for plan-specific network status.

---

## Aetna (H1609)
- **Provider Lookup:** https://www.aetna.com/medicare/find-provider.html
  - _Guest search — Continue as guest → Individual Medicare. Pick plan year **2027** in the year dropdown. No member login. Max queries this API (taxonomy by NPI, then MA search + plan list)._
- **Drug/Formulary Lookup:** https://www.aetna.com/medicare/prescription-drugs.html
  - _Tip: Members can also log in at AetnaMedicare.com for plan-specific drug search._

---

## CarePlus (H1019)
- **Provider Lookup:** https://www.careplushealthplans.com/members/member-resources/provider-directories
  - _**2027 PDFs (AEP):** Miami-Dade https://assets.humana.com/is/content/humana/H1019FLHM01JG27pdf · Broward https://assets.humana.com/is/content/humana/H1019FLHM01CG27pdf · Palm Beach https://assets.humana.com/is/content/humana/H1019FLHM01IG27pdf. 2026 PDFs are on the same page. Max checks CarePlus doctors only through Sunfire._
- **Drug/Formulary Lookup:** https://www.careplushealthplans.com/medicare/medicare-advantage-plans/prescription-drugs-list
  - _Lists 2026 Prescription Drug Guides (comprehensive formulary PDFs by plan)._

---

## Devoted Health (H1290)
- **Provider Lookup:** https://www.devoted.com/search-providers
- **Drug/Formulary Lookup:** https://www.devoted.com/search-formulary
  - _Both tools are public-facing and require ZIP code; no login needed. Max checks Devoted doctors live through Devoted's public FHIR directory (one network for every Devoted plan)._

---

## Doctors Healthcare Plans (H4140)
- **Provider Lookup (live search):** https://providersearch.doctorshcp.com
  - _Max queries this by NPI (PCP + specialist). Not on THEI Sunfire. API does not return a CMS plan ID — a hit means the NPI is in the Doctors directory._
- **Provider Lookup (2027 directory page):** https://www.doctorshcp.com/2027providers/
  - _The old `/2026Providers/` page now returns 404. DrMax-Dade (H4140-022) and DrSelect-SFL (H4140-023) share one network (Yahoska, 2026-10-06)._
- **Drug/Formulary Lookup (2027 PDF — Max uses this):** https://www.doctorshcp.com/wp-content/uploads/2027_FORMULARY.pdf
  - _Landing: https://www.doctorshcp.com/2027druglist/. Shared H4140 list (tier + PA/ST/QL). 2027 PBP remap: H4140-001→022, H4140-012→023, H4140-004→024. Do not use the member portal or the page search widget._
- **Drug/Formulary Lookup (2026 archive):** https://www.doctorshcp.com/2026druglist/

---

## Florida Blue / GuideWell (H1035)
- **Provider Lookup:** https://providersearch.floridablue.com/visitor/medicare
  - _Public search available; log in for plan-specific network results._
- **Drug/Formulary Lookup:** https://member.myhealthtoolkitfl.com/web/public/brands/fl/prescription-drugs
  - _Includes "Drug Search 2026" tool; select your formulary for plan-specific results._

---

## Gold Kidney Health Plans (H1526)
- **Provider Lookup:** https://www.goldkidney.com/provider-search
  - _Specialized ESRD/kidney-focused HMO-POS C-SNP. "SEARCH NOW" opens their provider portal; no PDF — printed directory by mail from Member Services (844) 294-6535. Max cannot search Gold Kidney itself._
- **Drug/Formulary Lookup:** https://goldkidney.com/covered-drugs
  - _Full 2026 formulary searchable online; downloadable PDF also available._

---

## HealthSpring / Cigna (H5410)
- **Provider Lookup:** https://healthspring-search.phynd.com
  - _Cigna HealthSpring provider search tool (legacy HealthSpring brand, operated by Cigna)._
- **Drug/Formulary Lookup:** https://www.healthspring.com/medicare/member-resources/drug-list-formulary
  - _Lists 2026 MA and PDP drug lists; includes prior authorization and step therapy criteria._

---

## HealthSun / Elevance (H5431)
- **Provider Lookup:** https://healthsun.com/provider-directory/
  - _**2027 directories on this page:** "2027 Provider and Pharmacy Directory" and "2027 Dual Special Needs Population Provider and Pharmacy Directory" (both updated 09/04/2026). The PDF file names change with each update — link the page, not the PDF._
  - _Not on THEI Sunfire. Max uses HealthSun’s public FHIR directory (Aaneel) with payer-id. A FHIR hit is carrier-level (✅ In*); an empty FHIR result means not listed — confirm with HealthSun, never call it Out._
- **Drug/Formulary Lookup:** https://directorysearch.healthsun.com/
  - _HealthSun Formulary Search tool; also accessible via the HealthSun homepage._

---

## Humana (H1036, H7617)
- **Provider Lookup (guest — Max uses this):** https://findcare.humana.com
  - _Search as a guest. No member login. Max queries 2027 Medicare networks by NPI (FL Medicare HMO27 / HIDE / FIDE / PPO27) and maps THEI CMS IDs onto that network. Failed check ≠ out of network._
- **Drug/Formulary Lookup:** https://www.humana.com/medicaredruglist
  - _Official Humana Medicare drug list portal; cited in 2026 Summary of Benefits documents._

---

## Simply Healthcare / Elevance (H5471)
- **Provider Lookup (Find Care guest):** https://findcare.simplyhealthcareplans.com/?brand=SHC
  - _Basic search as a guest. No member login. Max uses the same guest JWT + search-box (name search, then match NPI). Shop GraphQL getProviders is not usable from Max’s host._
- **Provider Lookup (shop tool):** https://shop.simplyhealthcareplans.com/medicare/standalonetools/find-doctor?brand=SIMPLY
- **Drug/Formulary Lookup:** https://shop.simplyhealthcareplans.com/medicare/standalonetools/find-covered-drugs?brand=SIMPLY
  - _Both shop tools are public-facing (no login required); show cost estimates across available plans._

---

## Solis Health Plans (H0982)
- **Provider Lookup (2027):** https://solishealthplans.com/2027/find-a-provider
  - _Live name / ZIP search on the page (new). When probed 2026-10-06 it was slow (30s+) and often errored — retry, or use the PDFs._
  - _**2027 county PDFs:** Miami-Dade https://soliscdrapi.azurewebsites.net/doc/ProvDirecMD_All_Next · Broward & Palm Beach https://soliscdrapi.azurewebsites.net/doc/ProvDirecBDPB_All_Next · Central FL https://soliscdrapi.azurewebsites.net/doc/ProvDirecCFL_All_Next. The links download a PDF (Chrome may show a blank/error tab — check Downloads)._
  - _2026 = same names ending `_Current` (2026 page: https://solishealthplans.com/2026/find-a-provider)._
  - _2027 SOB / EOC pattern: `SB{PBP}_ENG_Next` / `EOC{PBP}_ENG_Next` (e.g. H0982-016 → SB016_ENG_Next)._
  - _Not on THEI Sunfire. Max cannot search Solis doctors itself; cells stay ❔ unchecked._
- **Drug/Formulary Lookup:** https://solishealthplans.com/2027/pharmacy (2027) · https://solishealthplans.com/2026/pharmacy (2026)
  - _Drug List is a PDF download; no interactive online search tool. Call (833) 516-0475 for drug coverage questions._

---

## UHC MedicareMax / Medica (H5420)
_(Administered by Preferred Care Network / PCN Health)_
- **Provider Lookup (Max):** same UHC guest Find a Doctor as Preferred / AARP — https://findcare.guest.uhc.com/guest-plan-selection/browse (2027, no login).
- **Provider Lookup (PCN PDFs):** https://www.pcnhealth.com/en/provider-facility
  - _2027 PDFs for MedicareMax FL-0028, FL-0029 and Complete Care FL-30 (checked 2026-10-06), plus Behavioral Health, Pharmacy, Optometry and Dental._
- **Drug/Formulary Lookup:** https://www.pcnhealth.com/en/members/pharmacy-rx
  - _Formulary (Drug List) PDFs downloadable by plan (FL-0028, Complete Care FL-30, Dual Complete D-SNP)._

---

## UHC Preferred Care / AARP (H1045, H1889)
- **Provider Lookup (guest — Max uses this):** https://www.uhc.com/find-a-doctor → Continue as guest → Medicare, or https://findcare.guest.uhc.com/guest-plan-selection/browse
  - _No member login. No Jarvis. Max queries the same 2027 guest directory by NPI for THEI Duals (H1045-012 / 061 / 063) and other individual UHC plans in the county. Failed check ≠ out of network._
- **Member portal (do not use for Max):** https://www.myaarpmedicare.com
- **Drug/Formulary Lookup:** https://www.myaarpmedicare.com
  - _Member portal for drug list, formulary search, and cost estimates. Per 2026 ANOC, review the Provider Directory and formulary at myAARPMedicare.com._
  - _Formulary ID: 00026002 (AARP MA plans). Call 1-866-627-7806 (TTY 711) for assistance._

---

## WellCare / Sunshine Health (H1032)
- **Provider Lookup:** https://www.wellcare.com/en/fap
  - _"Find a Provider" tool; select Medicare Advantage plan type to search Florida network. Page showed no 2027 option when checked 2026-10-06 — confirm the plan year in the tool. Max checks Wellcare only through Sunfire._
- **Drug/Formulary Lookup:** https://www.wellcare.com/en/florida/members/medicare-advantage/pharmacy/drug-list-formulary
  - _Florida MA member formulary page with drug search tool and downloadable 2026 drug list. Pharmacy PA questions: 1-855-538-0454._

---

## Quick Reference: Carrier Phone Numbers (for lookup assistance)
| Carrier | Member Services |
|---|---|
| Aetna | 1-800-282-5366 (TTY 711) |
| CarePlus | 1-800-794-5907 (TTY 711) |
| Devoted Health | 1-800-338-6833 (TTY 711) |
| Doctors Healthcare Plans | 1-786-460-3427 / 1-833-342-7463 (TTY 711) |
| Florida Blue | 1-800-926-6565 (TTY 711) |
| Gold Kidney Health Plans | 1-844-294-6535 (TTY 711) |
| HealthSpring / Cigna | 1-800-668-3813 (TTY 711) |
| HealthSun | 1-877-336-2069 (TTY 711) |
| Humana | 1-800-833-6917 (TTY 711) |
| Simply Healthcare | 1-866-805-4589 (TTY 711) |
| Solis Health Plans | 1-833-516-0475 (TTY 711) |
| UHC MedicareMax (PCN) | 1-800-407-9069 (TTY 711) |
| UHC / AARP | 1-866-627-7806 (TTY 711) |
| WellCare / Sunshine Health | 1-800-783-8386 (TTY 711) |

---

_Source: Carrier websites, 2026 Summary of Benefits documents, and Provider Directories. Verified July 2026._
_For broker use only. Always direct members to their plan's member services for plan-specific coverage questions._
