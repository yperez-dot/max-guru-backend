// Regression for the four Broward 2027 workup bugs (2026-10-26).
// Synthetic names only: Carla Nguyen, Jordan Hale, Summit Rehab.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { fhirCheck } = require('./providerNetwork');

const PERSON_NPI = '1000000018';
const CLINIC_NPI = '1999999966';

const WK = `LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript).
Client: Carla Nguyen
ZIP/county: 33322 / Broward
Plans:
- UHC Preferred MA FL-0002 (H1045-005)
- Doctors DrSelect-SFL (H4140-023)
- Solis Healthy Living (H0982-007)
Doctors (names only — pass exactly these names to lookup_provider_network): Jordan Hale; Summit Rehab`;

const ASK = 'ZIP 33322 Broward. Carla Nguyen. Compare HealthSun Health Advantage Plus H5431-018, UHC Preferred MA FL-0002 H1045-005, Doctors DrSelect-SFL H4140-023.';

function doc(name, extra = {}) {
  return {
    requestedName: name,
    doctorName: name,
    npi: extra.npi || '1000000001',
    status: 'done',
    pending: [],
    failed: [],
    inNetworkPlans: extra.inNetworkPlans || [],
    outOfNetworkPlans: extra.outOfNetworkPlans || [],
    carriersIn: extra.carriersIn || [],
    networks: extra.networks || [],
    ...extra,
  };
}

function rowOf(text, name) {
  return text.split('\n').find((l) => l.startsWith(`| ${name}`)).split('|').map((c) => c.trim()).slice(1, -1);
}

function wkMsgs(ask) {
  return [{ role: 'user', content: WK }, { role: 'user', content: ask }];
}

describe('1. "no meds" and plan names are never drugs', () => {
  it('"no meds" on the original paste is an empty list', () => {
    assert.deepEqual(R.medsFromAsk('Carla Nguyen, 33322, Dr. Jordan Hale, Summit Rehab, no meds'), []);
    assert.equal(R.saidNoMeds('Carla Nguyen, 33322, no meds'), true);
  });

  it('Meds: DrSelect-SFL / a plan nickname is not a drug', () => {
    assert.equal(R.isPlanOrCarrierName('DrSelect-SFL'), true);
    assert.equal(R.isPlanOrCarrierName('HealthSun Health Advantage Plus'), true);
    assert.deepEqual(R.medsFromAsk('Meds: DrSelect-SFL'), []);
    assert.deepEqual(R.medsFromAsk('Meds: Doctors DrSelect-SFL'), []);
    assert.deepEqual(R.medsFromAsk('ZIP 33322. Meds: H5431-018'), []);
  });

  it('a real labeled list still reads', () => {
    assert.deepEqual(R.medsFromAsk('Carla Nguyen. Meds: metformin, lisinopril'), ['metformin', 'lisinopril']);
  });

  it('numbered "Any meds?" + a plan name does not become Meds:', () => {
    const msgs = [
      { role: 'assistant', content: '**To narrow to 2–3 plans:**\n1. Any meds to check against the finalists? (names only)' },
      { role: 'user', content: '1. DrSelect-SFL' },
    ];
    const ask = N.comparisonAskText(msgs, 'ZIP 33322. Carla Nguyen.');
    assert.doesNotMatch(ask, /Meds:\s*DrSelect/i);
    assert.deepEqual(R.medsFromAsk(ask), []);
  });

  it('a saved workup bullet of DrSelect-SFL is cleared by "no meds"', () => {
    const ask = `${WK}\nMedications (tiers shown for the compared plans):\n- DrSelect-SFL: H4140-023 lookup failed\n\nno meds`;
    assert.deepEqual(R.medsFromAsk(ask), []);
  });

  it('compare-card parse drops a plan nickname and honors no meds', () => {
    const { parseCompareAsk } = require('./compareJobs');
    assert.deepEqual(parseCompareAsk('Carla Nguyen, 33322. Meds: DrSelect-SFL. Doctors: Jordan Hale.').meds, []);
    assert.deepEqual(parseCompareAsk('Carla Nguyen, 33322. Doctors: Jordan Hale. no meds').meds, []);
  });
});

describe('2. HealthSun directory: people stay partial; clinics get a real NPI check', () => {
  it('a clinic FHIR miss is ❌ Out; a person PDF miss stays ❔ not confirmed', () => {
    const person = doc('Jordan Hale', {
      npi: PERSON_NPI,
      inNetworkPlans: ['UHC Preferred MA FL-0002 (H1045-005)', 'Doctors DrSelect-SFL (H4140-023)'],
      carriersIn: ['UnitedHealthcare', 'Doctors HealthCare Plans'],
      networks: [{
        carrier: 'HealthSun', inNetwork: false, status: 'checked',
        directoryStatus: 'checked', directoryMatches: [], partialList: true,
      }],
    });
    const clinic = doc('Summit Rehab Llc', {
      npi: CLINIC_NPI,
      isOrg: true,
      inNetworkPlans: ['UHC Preferred MA FL-0002 (H1045-005)', 'Doctors DrSelect-SFL (H4140-023)'],
      carriersIn: ['UnitedHealthcare', 'Doctors HealthCare Plans'],
      networks: [{ carrier: 'HealthSun', inNetwork: false, status: 'checked', partialList: true }],
    });
    const t = N.batchSummaryForModel([person, clinic], ASK, {}).text;
    const hale = rowOf(t, 'Jordan Hale');
    const rehab = rowOf(t, 'Summit Rehab Llc');
    assert.match(hale[1], /not confirmed/);
    assert.doesNotMatch(hale[1], /Not in network/);
    assert.match(rehab[1], /Not in network \(not listed\)/);
    assert.equal(N.doctorIsOrg(clinic), true);
    assert.equal(N.doctorIsOrg(person), false);
  });

  it('a failed HealthSun clinic check stays ❔ unchecked, never assumed Out', () => {
    const clinic = doc('Summit Rehab Llc', {
      npi: CLINIC_NPI,
      isOrg: true,
      failed: ['HealthSun (FHIR)'],
      networks: [{ carrier: 'HealthSun', inNetwork: false, status: 'failed' }],
    });
    const t = N.batchSummaryForModel([clinic], ASK, {}).text;
    assert.match(rowOf(t, 'Summit Rehab Llc')[1], /unchecked/);
  });

  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('HealthSun Organization?identifier empty Bundle is a miss, not a failed check', async () => {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (/Organization\?/.test(url)) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) };
      return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) };
    };
    const r = await fhirCheck(CLINIC_NPI, { isOrg: true });
    assert.ok(seen.some((u) => new RegExp(`Organization\\?identifier=${CLINIC_NPI}`).test(u) && /payer-id=/.test(u)));
    assert.ok(!seen.some((u) => /OrganizationAffiliation/.test(u)));
    assert.ok(!r.failed.includes('HealthSun'));
    assert.ok(!r.hits.includes('HealthSun'));
  });

  it('HealthSun Organization?identifier with this NPI is In', async () => {
    global.fetch = async (url) => {
      if (/Organization\?/.test(url)) {
        return {
          ok: true, status: 200,
          json: async () => ({
            resourceType: 'Bundle', total: 1,
            entry: [{ resource: { identifier: [{ value: CLINIC_NPI }] } }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) };
    };
    const r = await fhirCheck(CLINIC_NPI, { isOrg: true });
    assert.ok(r.hits.includes('HealthSun'));
    assert.ok(!r.failed.includes('HealthSun'));
  });
});

describe('3. Named plans lock the comparison — Solis is never swapped in', () => {
  it('HealthSun + UHC + Doctors stay even when Solis has every doctor In', () => {
    const hale = doc('Jordan Hale', {
      inNetworkPlans: [
        'Solis Healthy Living (H0982-007)',
        'UHC Preferred MA FL-0002 (H1045-005)',
        'Doctors DrSelect-SFL (H4140-023)',
      ],
      carriersIn: ['Solis Health Plans', 'UnitedHealthcare', 'Doctors HealthCare Plans'],
      networks: [
        { carrier: 'HealthSun', inNetwork: false, status: 'checked', directoryStatus: 'checked', directoryMatches: [], partialList: true },
        { carrier: 'Solis Health Plans', inNetwork: true, status: 'checked', directoryMatches: [{ name: 'HALE, JORDAN', pages: [1] }] },
      ],
    });
    const sel = N.selectComparison([hale], ASK, {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.deepEqual(ids, ['H5431-018', 'H1045-005', 'H4140-023']);
    assert.ok(!ids.includes('H0982-007'));
    assert.match(sel.whyLine || '', /you named|no plans added or swapped/i);
  });

  it('a follow-up "also show Solis" does not replace three typed plan IDs', () => {
    const hale = doc('Jordan Hale', {
      inNetworkPlans: ['Solis Healthy Living (H0982-007)', 'UHC Preferred MA FL-0002 (H1045-005)'],
      carriersIn: ['Solis Health Plans', 'UnitedHealthcare'],
    });
    const msgs = [
      { role: 'user', content: 'Carla Nguyen, ZIP 33322. Compare HealthSun Health Advantage Plus H5431-018, UHC Preferred MA FL-0002 H1045-005, Doctors DrSelect-SFL H4140-023.' },
      { role: 'user', content: 'Compare HealthSun H5431-018, UHC H1045-005, Doctors H4140-023. Also show Solis.' },
    ];
    const ask = N.comparisonAskText(msgs);
    assert.doesNotMatch(ask, /^Carriers requested: Solis/m);
    const sel = N.selectComparison([hale], ask, {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.deepEqual(ids, ['H5431-018', 'H1045-005', 'H4140-023']);
    assert.ok(!ids.includes('H0982-007'));
  });
});

describe('4. Exact contract-PBP add; no other-county sibling; replace-in-place', () => {
  it('typed H5431-018 in Broward is only 018 — never Miami-Dade 017', () => {
    const r = N.planNamesInAsk('add HealthSun Health Advantage Plus · H5431-018', 'Broward');
    assert.deepEqual(r.ids, ['H5431-018']);
    assert.deepEqual(r.ambiguous, []);
  });

  it('typed H5431-018 is 018 even when the county grid has the 017 twin', () => {
    const r = N.planNamesInAsk('add HealthSun Health Advantage Plus · H5431-018', 'Miami-Dade');
    assert.deepEqual(r.ids, ['H5431-018']);
    assert.ok(!r.ids.includes('H5431-017'));
  });

  it('workup add by exact ID adds only that Broward plan', () => {
    const set = LW.workupPlanAddSet('add HealthSun Health Advantage Plus · H5431-018', wkMsgs('add HealthSun Health Advantage Plus · H5431-018'));
    const ids = set.map((p) => p.planId.slice(0, 9));
    assert.ok(ids.includes('H5431-018'));
    assert.ok(!ids.includes('H5431-017'));
    assert.deepEqual(set.added.map((id) => id.slice(0, 9)), ['H5431-018']);
  });

  it('an off-county twin is never a comparison column', () => {
    const hale = doc('Jordan Hale', { inNetworkPlans: ['UHC Preferred MA FL-0002 (H1045-005)'] });
    const ask = N.comparisonAskText(wkMsgs('add HealthSun Health Advantage Plus · H5431-017'));
    const sel = N.selectComparison([hale], ask, {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(!ids.includes('H5431-017'));
    assert.ok(sel.flags.some((f) => /Not offered in Broward: H5431-017/.test(f)), sel.flags.join('\n'));
  });

  it('remove X and replace with Y puts Y in X\'s place', () => {
    const set = LW.workupPlanAddSet('remove H0982-007 and replace with H5431-018', wkMsgs('remove H0982-007 and replace with H5431-018'));
    const ids = set.map((p) => p.planId.slice(0, 9));
    assert.deepEqual(ids, ['H1045-005', 'H4140-023', 'H5431-018']);
    assert.ok(!ids.includes('H0982-007'));
    assert.ok(!ids.includes('H5431-017'));
  });

  it('comparisonAskText add-by-ID names only H5431-018', () => {
    const ask = N.comparisonAskText(wkMsgs('add HealthSun Health Advantage Plus · H5431-018'));
    assert.match(ask, /H5431-018/);
    assert.doesNotMatch(ask, /H5431-017/);
  });

  it('selectComparison drops a named plan not offered in the client county', () => {
    const hale = doc('Jordan Hale', {
      inNetworkPlans: ['UHC Preferred MA FL-0002 (H1045-005)', 'Doctors DrSelect-SFL (H4140-023)'],
    });
    const sel = N.selectComparison([hale], 'ZIP 33322 Broward. Compare UHC H1045-005, Doctors H4140-023 and HealthSun H5431-017', {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(!ids.includes('H5431-017'));
    assert.ok(sel.flags.some((f) => /Not offered in Broward: H5431-017/.test(f)), sel.flags.join('\n'));
  });
});
