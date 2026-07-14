# THEI 147-Plan Grid — Non-Commissionable Flags
**Primary source:** `2026_Non-Commissionable_Suppressed_SAR_MA-PDP_Plans_010226.xlsx` (CMS authoritative, published 1/2/2026)  
**Secondary source:** Humana carrier doc GCHMRX7EN 01/2026 (mid-year amendments, Batch 2 effective 4/1/2026)  
**Last updated:** 2026-07-10  
**Confirmed by:** CMS SAR file parse + Humana carrier doc cross-reference

---

## The 12 Non-Commissionable Plans in THEI's Grid

> **Commission rule for all:** New sales = ❌ non-commissionable. Renewals = ✅ 2026 FMV applies.

### From CMS SAR File (effective 1/1/2026)

| Contract-PBP | Carrier | Plan Name | Type |
|-------------|---------|-----------|------|
| H1035-017 | Florida Blue HMO | BlueMedicare Classic | HMO |
| H1035-019 | Florida Blue HMO | BlueMedicare Classic | HMO |
| H1035-025 | Florida Blue HMO | BlueMedicare Premier | HMO |
| H5434-002 | Florida Blue | BlueMedicare Select | PPO |
| H5434-026 | Florida Blue | BlueMedicare Value | PPO |
| R0759-001 | UnitedHealthcare | AARP Medicare Advantage from UHC FL-0031 | Regional PPO |
| H5216-311 | Humana | Humana Full Access Giveback H5216-311 | PPO |
| H5216-393 | Humana | Humana Full Access Giveback H5216-393 | PPO |
| H5471-077 | Simply Healthcare / Elevance | Simply More | HMO |
| H5471-080 | Simply Healthcare / Elevance | Simply Level | HMO C-SNP |

### From Humana Carrier Doc (mid-year amendment, effective 4/1/2026)

These plans became non-commissionable **after** the CMS January file was published. Applies to signatures on or after **3/3/2026** with effective dates on or after **4/1/2026**.

| Contract-PBP | Carrier | Plan Name | Type |
|-------------|---------|-----------|------|
| H7617-107 | Humana | HumanaChoice Florida H7617-107 | PPO |
| H7617-110 | Humana | Humana Full Access Giveback H7617-110 | PPO |

---

## Data Schema (for Max backend when built)

```json
{
  "contract": "H7617",
  "pbp": "107",
  "carrier": "Humana",
  "plan_name": "HumanaChoice Florida H7617-107 (PPO)",
  "plan_type": "PPO",
  "commissionable_new_sales": false,
  "commissionable_renewals": true,
  "noncomm_effective_date": "2026-04-01",
  "noncomm_signature_cutoff": "2026-03-03",
  "commission_note": "Non-commissionable for new sales with signature date on/after 2026-03-03 effective 2026-04-01. Renewals pay 2026 FMV.",
  "commission_source": "Humana GCHMRX7EN 01/2026 (Batch 2)"
}
```

For 1/1/2026 plans, use `"noncomm_effective_date": "2026-01-01"` and omit `noncomm_signature_cutoff`.

For commissionable plans: `"commissionable_new_sales": true, "commissionable_renewals": true, "commission_note": null`

---

## Authoritative Sources (ranked by authority)

1. **`2026_Non-Commissionable_Suppressed_SAR_MA-PDP_Plans_010226.xlsx`** — CMS primary source, 1/2/2026, contract/PBP/county structured, Non-Commissionable column. Use this first.
2. **Humana GCHMRX7EN 01/2026** — Humana carrier doc, three mid-year amendment batches (1/1, 4/1, 6/1 effective dates).
3. **Simply/Elevance Y0114_26_3018026_0000_I_C** — Commission rules for Simply Healthcare plans.

Other files in THEI Drive (2 Humana PDFs, 2 Simply/Elevance PDFs, 1 UHC xlsx, 1 national CMS PDF) are carrier-specific backups → for Agent Hub reference, not Max's primary data.
