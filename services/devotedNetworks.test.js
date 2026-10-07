// Devoted: In only on plans whose own network lists the doctor (Gail Carreno, 2026-10-07).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const D = require('./devotedNetworks');
const { fhirCheck } = require('./providerNetwork');
const exp = require('../artifacts/comparison-export.js');

// PractitionerRole entries as Devoted's FHIR returns them (network-reference extension).
const role = (orgId) => ({ resource: { resourceType: 'PractitionerRole', extension: [
  { url: 'http://hl7.org/fhir/us/davinci-pdex-plan-net/StructureDefinition/network-reference', valueReference: { reference: `Organization/${orgId}` } },
] } });
const FL_PPO = 'organization-ffffffff-0000-0000-0000-000000000000';

describe('Devoted plan → network map', () => {
  it('C-SNP, D-SNP and HMO plans each have their own network', () => {
    assert.equal(D.devotedPlanNetwork('H1290-085'), 'FL HMO C-SNP');
    assert.equal(D.devotedPlanNetwork('H1290-067'), 'FL HMO C-SNP');
    assert.equal(D.devotedPlanNetwork('H1290-078'), 'FL HMO D-SNP');
    assert.equal(D.devotedPlanNetwork('H1290-001'), 'FL HMO');
  });

  it('Rincon Buendia (FL HMO + FL HMO D-SNP + FL PPO) is Out on H1290-085, In on H1290-001', () => {
    const refs = D.devotedNetworkRefs({ entry: [role(D.FL_HMO.ref), role(D.FL_HMO_DSNP.ref), role(FL_PPO)] });
    const v = D.devotedPlanVerdicts(refs, 2027);
    assert.ok(v.outPlans.some((l) => /H1290-085/.test(l)));
    assert.ok(v.inPlans.some((l) => /H1290-001/.test(l)));
    assert.ok(v.inPlans.some((l) => /H1290-078/.test(l)));
  });

  it('Martel (FL PPO only) is Out on every Florida Devoted HMO / SNP plan', () => {
    const v = D.devotedPlanVerdicts(D.devotedNetworkRefs({ entry: [role(FL_PPO)] }), 2027);
    assert.equal(v.inPlans.length, 0);
    assert.equal(v.outPlans.length, Object.keys(D.DEVOTED_PLANS_2027).length);
  });

  it('no verified map for other years → null (callers keep the carrier-level fallback)', () => {
    assert.equal(D.devotedPlanVerdicts([D.FL_HMO.ref], 2026), null);
    assert.equal(D.devotedPlanVerdicts(null, 2027), null);
  });
});

describe('fhirCheck returns the doctor\'s Devoted networks', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('reads network refs across pages', async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/devoted/.test(u) && /page=2/.test(u)) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [role(D.FL_HMO_DSNP.ref)] }) };
      if (/devoted/.test(u)) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 2, entry: [role(FL_PPO)], link: [{ relation: 'next', url: 'https://fhir.devoted.com/fhir/PractitionerRole?page=2' }] }) };
      return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) };
    };
    const r = await fhirCheck('1699977884');
    assert.deepEqual(r.hits, ['Devoted Health']);
    assert.deepEqual(r.devotedNetworks.refs.sort(), [D.FL_HMO_DSNP.ref, FL_PPO].sort());
    assert.equal(r.devotedNetworks.complete, true);
  });
});

describe('export + chat table use the plan-level Devoted answer', () => {
  it('a Devoted carrier-level hit no longer paints H1290-085 In when the plan-level answer says Out', () => {
    const plans = [{ planId: 'H1290-085', planName: 'Devoted C-SNP PLUS', carrier: 'Devoted' }, { planId: 'H1290-001', planName: 'Devoted CORE 001', carrier: 'Devoted' }];
    const v = D.devotedPlanVerdicts([D.FL_HMO.ref], 2027);
    const docs = exp.doctorsFromProviderLookups([{ doctorName: 'NATALIA RINCON BUENDIA', npi: '1902300361', networks: [
      { carrier: 'Devoted Health', inNetwork: true, status: 'checked', plans: v.inPlans, outOfNetworkPlans: v.outPlans },
    ] }], plans);
    assert.deepEqual(docs[0].statuses, [exp.NETWORK_OUT, exp.NETWORK_IN]);
  });

  it('doctorPlanNarrow named columns: plan-level Out beats the single-network carrier rule', () => {
    const N = require('./doctorPlanNarrow');
    const v = D.devotedPlanVerdicts([D.FL_HMO.ref], 2027);
    const doctor = {
      doctorName: 'NATALIA RINCON BUENDIA', requestedName: 'Natalia Rincon', npi: '1902300361', status: 'done',
      inNetworkPlans: ['Devoted Health', ...v.inPlans], outOfNetworkPlans: v.outPlans, carriersIn: ['Devoted Health'],
      networks: [{ carrier: 'Devoted Health', inNetwork: true, status: 'checked' }], failed: [], pending: [],
    };
    const t = N.batchSummaryForModel([doctor], 'Compare Devoted C-SNP PLUS H1290-085 and Devoted CORE H1290-001 for these doctors', {}).text;
    const line = t.split('\n').find((l) => /Rincon/i.test(l) && /\|/.test(l));
    assert.ok(line, t);
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    const header = t.split('\n').find((l) => /H1290-085/.test(l) && /\|/.test(l)).split('|').map((c) => c.trim()).filter(Boolean);
    const at085 = header.findIndex((h) => /H1290-085/.test(h));
    const at001 = header.findIndex((h) => /H1290-001/.test(h));
    assert.match(cells[at085], /Not in network \(not listed\)/);
    assert.match(cells[at001], /In/);
  });
});
