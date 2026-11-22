// services/devotedNetworks.js — Devoted plan → provider network (2027 Florida).
//
// Devoted's FHIR directory links each PractitionerRole to ONE network Organization
// ("FL HMO", "FL HMO D-SNP", "FL HMO C-SNP", "FL PPO", plus other states). A doctor
// being anywhere in Devoted's directory is NOT In on every Devoted plan: the C-SNP
// plans use their own "FL HMO C-SNP" network (Gail Carreno, 2026-10-07 — Rincon
// Buendia is on FL HMO / FL HMO D-SNP / FL PPO, Martin on FL HMO D-SNP / FL PPO,
// Martel on FL PPO only; none is on H1290-085's FL HMO C-SNP network).
//
// Map verified live 2026-10-07 from https://fhir.devoted.com/fhir/InsurancePlan/
// insuranceplan-<id>-000 (period 2027-01-01..2027-12-31) → network[].reference.
// Re-check each AEP: `python3 /workspace/gail-verify/devoted_plans.py`.

const FL_HMO = { ref: 'organization-5a626d91-7e8a-4fee-ad72-03a067361dcb', name: 'FL HMO' };
const FL_HMO_DSNP = { ref: 'organization-d6a71755-d335-4cca-94fa-b4b1dc93ff1b', name: 'FL HMO D-SNP' };
const FL_HMO_CSNP = { ref: 'organization-eefff478-d195-498e-8fb3-836c533680c3', name: 'FL HMO C-SNP' };

const DEVOTED_PLANS_2027 = {
  'H1290-001': { name: 'Devoted CORE 001', network: FL_HMO },
  'H1290-002': { name: 'Devoted CORE 002', network: FL_HMO },
  'H1290-013': { name: 'Devoted GIVEBACK 013', network: FL_HMO },
  'H1290-014': { name: 'Devoted GIVEBACK 014', network: FL_HMO },
  'H1290-037': { name: 'Devoted CORE 037', network: FL_HMO },
  'H1290-056': { name: 'Devoted CORE 056', network: FL_HMO },
  'H1290-062': { name: 'Devoted CORE 062', network: FL_HMO },
  'H1290-110': { name: 'Devoted GIVEBACK EXTRAS 110', network: FL_HMO },
  'H1290-117': { name: 'Devoted GIVEBACK EXTRAS 117', network: FL_HMO },
  'H1290-019': { name: 'Devoted DUAL 019 D-SNP', network: FL_HMO_DSNP },
  'H1290-020': { name: 'Devoted DUAL 020 D-SNP', network: FL_HMO_DSNP },
  'H1290-053': { name: 'Devoted DUAL QMB 053 D-SNP', network: FL_HMO_DSNP },
  'H1290-054': { name: 'Devoted DUAL QMB 054 D-SNP', network: FL_HMO_DSNP },
  'H1290-077': { name: 'Devoted DUAL FULL 077 D-SNP', network: FL_HMO_DSNP },
  'H1290-078': { name: 'Devoted DUAL FULL 078 D-SNP', network: FL_HMO_DSNP },
  'H1290-067': { name: 'Devoted C-SNP ENHANCED 067', network: FL_HMO_CSNP },
  'H1290-073': { name: 'Devoted C-SNP ENHANCED 073', network: FL_HMO_CSNP },
  'H1290-084': { name: 'Devoted C-SNP PLUS 084', network: FL_HMO_CSNP },
  'H1290-085': { name: 'Devoted C-SNP PLUS 085', network: FL_HMO_CSNP },
};

function refId(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  const parts = s.split('/');
  return parts[parts.length - 1];
}

const KNOWN_BY_NAME = {
  'fl hmo': FL_HMO.ref,
  'fl hmo d-snp': FL_HMO_DSNP.ref,
  'fl hmo dsnp': FL_HMO_DSNP.ref,
  'fl hmo c-snp': FL_HMO_CSNP.ref,
  'fl hmo csnp': FL_HMO_CSNP.ref,
};

/** Network Organization ids a Devoted PractitionerRole bundle links the doctor to. */
function devotedNetworkRefs(bundle) {
  const out = new Set();
  const orgNames = {};
  for (const e of (bundle && bundle.entry) || []) {
    const r = (e && e.resource) || {};
    if (r.resourceType === 'Organization' && r.id) orgNames[r.id] = r.name || r.id;
  }
  for (const e of (bundle && bundle.entry) || []) {
    const r = (e && e.resource) || {};
    if (r.resourceType && r.resourceType !== 'PractitionerRole') continue;
    const roleNets = new Set();
    for (const ext of r.extension || []) {
      if (String(ext.url || '').includes('network-reference') && ext.valueReference && ext.valueReference.reference) {
        roleNets.add(refId(ext.valueReference.reference));
      }
    }
    for (const n of r.network || []) if (n && n.reference) roleNets.add(refId(n.reference));
    // Same fallback as routes/providerLookup.parseNetworkNames: Devoted often puts the
    // network on .organization when the PDex network-reference extension is missing.
    if (!roleNets.size && r.organization && r.organization.reference) {
      roleNets.add(refId(r.organization.reference));
    }
    for (const id of roleNets) {
      out.add(id);
      const nm = String(orgNames[id] || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (KNOWN_BY_NAME[nm]) out.add(KNOWN_BY_NAME[nm]);
    }
  }
  out.delete('');
  return [...out];
}

function planLabel(id, plan) {
  return `${plan.name} (${id})`;
}

/**
 * Plan-level verdicts for every mapped Devoted plan. `networkRefs` = the doctor's
 * Devoted networks from a FINISHED directory check (an empty array = not listed at
 * all → Out everywhere). Returns null for years without a verified map, so callers
 * keep the carrier-level fallback instead of guessing.
 */
function devotedPlanVerdicts(networkRefs, planYear, opts = {}) {
  if (!Array.isArray(networkRefs)) return null;
  if (Number(planYear) !== 2027) return null;
  const have = new Set(networkRefs.map(refId).filter(Boolean));
  const inPlans = [];
  const outPlans = [];
  // Listed on Devoted (FHIR n>0) but no mapped network ref: that is not a plan-level miss.
  // Painting every 2027 Devoted plan Out here is how a directory hit became "Not in network".
  if (!have.size) {
    if (opts.carrierListed) return { inPlans: [], outPlans: [], unmapped: true };
    for (const [id, plan] of Object.entries(DEVOTED_PLANS_2027)) outPlans.push(planLabel(id, plan));
    return { inPlans, outPlans };
  }
  for (const [id, plan] of Object.entries(DEVOTED_PLANS_2027)) {
    (have.has(plan.network.ref) ? inPlans : outPlans).push(planLabel(id, plan));
  }
  return { inPlans, outPlans };
}

function devotedPlanNetwork(planId) {
  const id = String(planId || '').toUpperCase().slice(0, 9);
  const plan = DEVOTED_PLANS_2027[id];
  return plan ? plan.network.name : null;
}

module.exports = {
  DEVOTED_PLANS_2027,
  FL_HMO,
  FL_HMO_DSNP,
  FL_HMO_CSNP,
  devotedNetworkRefs,
  devotedPlanVerdicts,
  devotedPlanNetwork,
};
