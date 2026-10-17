const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');
const W = require('../artifacts/client-workups.js');
const { conversationAskText } = require('./planYear');
const { resolveNpiRecords, joinedParticleSplits } = require('./npiRegistry');
const { sameCoreDrug } = require('./drugNames');

// Nancy Blanco De Pajaro, ZIP 33193 (2026-10-17): loaded workup with UHC H5420-001, Doctors H4140-022,
// CarePlus H1019-006. "Dr. Edgardo de Arriba and Dr. Humberto Carlos Machado are part of Cano Health. They are in
// network witth Humana and Doctors. Drop careplus and add Humana. Re tun this" → UHC was dropped, DrSelect added,
// Humana missing, the saved "Edgardo Dearriba" was searched again, and brimonidine/timolol fell off the meds.
const WK = {
  clientName: 'Nancy Blanco De Pajaro', zip: '33193', county: 'Miami-Dade',
  plans: [
    { carrier: 'UHC', planName: 'UHC MedicareMax FL-0028', planId: 'H5420-001' },
    { carrier: 'Doctors', planName: 'Doctors DrMax-Dade', planId: 'H4140-022' },
    { carrier: 'CarePlus', planName: 'CarePlus CareOne Plus', planId: 'H1019-006' },
  ],
  doctors: [{ name: 'Edgardo Dearriba' }, { name: 'Humberto Machado', npi: '1225079668' }, { name: 'Vision Unlimited', npi: '1003187568' }, { name: 'Ciro Martin', npi: '1093855256' }],
  medications: [{ name: 'BRIMONIDINE TARTRATE/TIMOLOL MALEATE SOLUTION 0.2/0.5%' }, { name: 'Entresto' }, { name: 'Farxiga' }],
};
const ASK = 'Dr. Edgardo de Arriba and Dr. Humberto Carlos Machado are part of Cano Health.  They are in network witth Humana and Doctors. Drop careplus and add Humana. Re tun this';
const run = (text) => {
  const m = W.messagesForApi([{ role: 'user', content: text }], WK);
  const ask = N.comparisonAskText(m, conversationAskText(m));
  return { m, ask };
};
const doc = (n) => ({ status: 'done', requestedName: n, doctorName: n, inNetworkPlans: [], outOfNetworkPlans: [], networks: [], carriersIn: [] });

describe('Nancy Blanco De Pajaro: drop CarePlus, add Humana on a loaded workup', () => {
  it('plans are exactly UHC, DrMax and Humana core — no DrSelect sibling', () => {
    const { m, ask } = run(ASK);
    assert.deepEqual(N.namedPlansFromAsk(ask, N.askConstraints(ask)).map((p) => p.planId), ['H5420-001', 'H4140-022', 'H1036-054C']);
    const f = N.comparisonFollowUp(m);
    const cols = N.selectComparison(f.doctors.map(doc), ask, {}).columns.map((c) => c.planId);
    assert.deepEqual(cols, ['H5420-001', 'H4140-022', 'H1036-054C']);
  });
  it('"remove careplus" alone keeps the other saved plans', () => {
    const { ask } = run('remove careplus');
    assert.deepEqual(N.namedPlansFromAsk(ask, N.askConstraints(ask)).map((p) => p.planId), ['H5420-001', 'H4140-022']);
  });
  it('"add Dr. …" is not a carrier add', () => {
    const { ask } = run('add Dr. Jane Roe');
    assert.deepEqual(N.namedPlansFromAsk(ask, N.askConstraints(ask)).map((p) => p.planId), ['H5420-001', 'H4140-022', 'H1019-006']);
  });
});

describe('Nancy: corrected doctor name replaces the stale saved row', () => {
  it('"Dr. Edgardo de Arriba" replaces "Edgardo Dearriba"; the rest stay', () => {
    const f = N.comparisonFollowUp(run(ASK).m);
    assert.deepEqual(f.doctors, ['Edgardo de Arriba', 'Humberto Machado', 'Vision Unlimited', 'Ciro Martin']);
  });
  it('particle surnames typed joined get split variants', () => {
    assert.deepEqual(joinedParticleSplits('Dearriba'), ['De Arriba', 'De-Arriba']);
    assert.ok(joinedParticleSplits('Delaguarda').includes('De La Guarda'));
    assert.deepEqual(joinedParticleSplits('Dean'), []);
    assert.deepEqual(joinedParticleSplits('Smith'), []);
  });
  const person = (n, first, last) => ({ number: n, enumeration_type: 'NPI-1', basic: { first_name: first, last_name: last, credential: 'MD' }, addresses: [{ address_purpose: 'LOCATION', postal_code: '331930000', state: 'FL' }], taxonomies: [{ primary: true, desc: 'Internal Medicine' }] });
  const withDir = async (DIR, fn) => {
    const saved = global.fetch;
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      const last = (q.get('last_name') || '').toUpperCase();
      const first = (q.get('first_name') || '').toUpperCase();
      const results = q.get('enumeration_type') === 'NPI-2' ? [] : DIR.filter((r) => r.basic.last_name === last && (!first || r.basic.first_name === first));
      return { ok: true, json: async () => ({ results }) };
    };
    try { await fn(); } finally { global.fetch = saved; }
  };
  it('NPPES: "Edgardo Dearriba" finds DE ARRIBA', async () => {
    await withDir([person('1111111111', 'EDGARDO', 'DE ARRIBA')], async () => {
      const r = await resolveNpiRecords({ doctorName: 'Edgardo Dearriba', zip: '33193' });
      assert.equal(r[0] && r[0].number, '1111111111');
    });
  });
  it('NPPES: "Edgardo de Arriba" finds DEARRIBA', async () => {
    await withDir([person('2222222222', 'EDGARDO', 'DEARRIBA')], async () => {
      const r = await resolveNpiRecords({ doctorName: 'Edgardo de Arriba', zip: '33193' });
      assert.equal(r[0] && r[0].number, '2222222222');
    });
  });
});

describe('Nancy: every saved med stays on the re-run', () => {
  it('brimonidine/timolol is kept under its short name', () => {
    assert.deepEqual(R.medsFromAsk(run(ASK).ask), ['brimonidine / timolol 0.2%/0.5% ophthalmic solution', 'Entresto', 'Farxiga']);
  });
  it('pharmacy-label spelling is the same drug as RxNorm\'s name (corrected, not "check name")', () => {
    assert.equal(sameCoreDrug('brimonidine tartrate timolol maleate solution 0 2 0 5', 'brimonidine tartrate 0.2 % / timolol maleate 0.5 % ophthalmic solution'), true);
    assert.equal(sameCoreDrug('brimonidine timolol', 'brimonidine tartrate'), false);
  });
});
