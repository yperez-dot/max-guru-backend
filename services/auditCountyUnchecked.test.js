// Audit fixes, 2026-10-07 (Yahoska): Solis + Doctors directory PDFs are scoped to HER county, the Solis
// Central Florida index is searched, and Aetna / Simply / Wellcare read ❔ unchecked when no lookup ran.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./solisDirectory');
const D = require('./doctorsHcp');
const N = require('./doctorPlanNarrow');
const { guestCheckStatus, sunfireCheckStatus } = require('./providerNetwork');
const { countiesForZip } = require('./flZipCounty');
const E = require('../artifacts/comparison-export.js');

describe('FL ZIP → county', () => {
  it('maps South and Central Florida ZIPs; unknown stays unknown', () => {
    assert.deepEqual(countiesForZip('33018'), ['Miami-Dade']);
    assert.deepEqual(countiesForZip('33030'), ['Miami-Dade']); // Homestead (the old 330xx rule said Broward)
    assert.deepEqual(countiesForZip('33324'), ['Broward']);
    assert.deepEqual(countiesForZip('33401'), ['Palm Beach']);
    assert.deepEqual(countiesForZip('32801'), ['Orange']);
    assert.deepEqual(countiesForZip('33602'), ['Hillsborough']);
    assert.deepEqual(countiesForZip('99999'), []);
  });
});

describe('Solis: county-scoped, Central Florida searched', () => {
  // ENZO ABAD is listed only in the Miami-Dade PDF; ANDREW ABADEER only in Central Florida.
  it('a Miami-Dade listing is In for a Miami-Dade client, and Out (not listed) for a Broward client', () => {
    const md = S.solisCheck({ firstName: 'ENZO', lastName: 'ABAD', zip: '33018' });
    assert.equal(md.status, 'checked');
    assert.equal(md.inNetwork, true);
    assert.deepEqual(md.matches[0].pages, [161]);
    const bw = S.solisCheck({ firstName: 'ENZO', lastName: 'ABAD', zip: '33324' });
    assert.equal(bw.status, 'checked'); // her county's (Broward & Palm Beach) index was searched
    assert.equal(bw.inNetwork, false); // → Out for Solis plans (the directory lists every network provider)
    assert.equal(bw.county, 'browardPalmBeach');
  });

  it('the Central Florida index is searched for its 7 counties', () => {
    const orl = S.solisCheck({ firstName: 'ANDREW', lastName: 'ABADEER', zip: '32801' });
    assert.equal(orl.status, 'checked');
    assert.equal(orl.inNetwork, true);
    assert.equal(orl.county, 'centralFl');
    assert.deepEqual(orl.matches[0].pages, [135]);
    assert.deepEqual(S.countiesForZip('33602').keys, ['centralFl']); // Tampa
    // …and a Central Florida listing is not In for a Miami-Dade client.
    assert.equal(S.solisCheck({ firstName: 'ANDREW', lastName: 'ABADEER', zip: '33018' }).inNetwork, false);
  });

  it('a county with no Solis directory (or an unknown ZIP) is never searched → unavailable, never Out', () => {
    for (const zip of ['32202', '', '99999']) {
      const r = S.solisCheck({ firstName: 'ENZO', lastName: 'ABAD', zip });
      assert.equal(r.status, 'unavailable', zip);
      assert.equal(r.inNetwork, false);
    }
  });
});

describe('Doctors HealthCare PDF index: county-scoped', () => {
  const idx = require('../data/doctors-directory-2027.json').counties;
  const tampaOnly = Object.keys(idx.tampa.npis).find((n) => !idx.miamiDade.npis[n] && !idx.broward.npis[n] && !idx.orlando.npis[n]);
  const mdOnly = Object.keys(idx.miamiDade.npis).find((n) => !idx.tampa.npis[n] && !idx.broward.npis[n] && !idx.orlando.npis[n]);

  it('a Tampa-only listing is not In for a Miami-Dade client (and the live site is not asked)', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => [] }; };
    try {
      const r = await D.queryDoctorsHcp(tampaOnly, { zip: '33018' });
      assert.equal(r.inNetwork, false);
      // A listing outside her area is not In — and not proof of Out: a failed check (❔ unchecked).
      assert.equal(r.error, 'other_county_only');
      assert.equal(r.source, 'pdf');
      assert.match(r.otherCountyOnly[0], /Hillsborough\/Pasco p\. \d+/);
      assert.equal(calls, 0);
    } finally { global.fetch = original; }
  });

  // Miami-Dade and Broward are ONE pool: the SFL plans cover both, and each county PDF lists only
  // doctors whose offices are in that county (Yahoska, 2026-10-07 — Gadh in Plantation read Out
  // for a Miami-Dade client).
  const brOnly = Object.keys(idx.broward.npis).find((n) => !idx.miamiDade.npis[n] && !idx.tampa.npis[n] && !idx.orlando.npis[n]);
  const fail = async () => { throw new Error('live site must not decide this'); };

  it('a Broward-only doctor is In for a Miami-Dade client', async () => {
    const original = global.fetch;
    global.fetch = fail;
    try {
      const r = await D.queryDoctorsHcp(brOnly, { zip: '33172' });
      assert.equal(r.inNetwork, true);
      assert.equal(r.error, null);
    } finally { global.fetch = original; }
  });

  it('a Miami-Dade-only doctor is In for a Broward client', async () => {
    const original = global.fetch;
    global.fetch = fail;
    try {
      const r = await D.queryDoctorsHcp(mdOnly, { zip: '33324' });
      assert.equal(r.inNetwork, true);
    } finally { global.fetch = original; }
  });

  it('Dr. Rundeep Gadh (Broward PDF) is In for a Miami-Dade client', async () => {
    const original = global.fetch;
    global.fetch = fail;
    try {
      assert.equal((await D.queryDoctorsHcp('1407095615', { zip: '33172' })).inNetwork, true);
    } finally { global.fetch = original; }
  });

  it('a doctor listed only outside her area renders ❔ unchecked in the table, never ❌ Out', () => {
    const N = require('./doctorPlanNarrow');
    const d = {
      doctorName: 'Tampa Doctor', requestedName: 'Tampa Doctor', npi: tampaOnly, status: 'done',
      pending: [], failed: ['Doctors HealthCare Plans'], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [],
      networks: [{ carrier: 'Doctors HealthCare Plans', inNetwork: false, status: 'failed' }],
    };
    const [col] = N.namedPlanColumns([{ planId: 'H4140-023', name: 'Doctors DrSelect-SFL' }], [], [d]);
    assert.equal(col.out.length, 0);
    assert.equal(col.in.length, 0);
    assert.equal(col.unknown.length, 1);
  });

  it('the same NPI is In for a Tampa client, with the PDF page', async () => {
    const r = await D.queryDoctorsHcp(tampaOnly, { zip: '33602' });
    assert.equal(r.inNetwork, true);
    assert.match(r.matches[0].address, /Hillsborough\/Pasco p\. \d+/);
  });

  it('a county with no Doctors PDF ignores other counties\' listings and asks the live site', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => [] }; };
    try {
      const r = await D.queryDoctorsHcp(mdOnly, { zip: '32202' }); // Jacksonville
      assert.equal(r.inNetwork, false);
      assert.ok(calls > 0);
    } finally { global.fetch = original; }
    assert.equal(D.doctorsPdfScoped(mdOnly, '32202').searched, false);
  });

  it('no ZIP (admin probe) keeps the any-county answer', () => {
    assert.ok(D.doctorsPdfCheck(tampaOnly).length > 0);
  });
});

describe('Aetna / Simply / Wellcare: ❔ unchecked when no lookup ran, ❔ not confirmed when it ran', () => {
  it('lookup status from the carrier result', () => {
    assert.equal(guestCheckStatus(undefined), 'unchecked');
    assert.equal(guestCheckStatus({ inNetwork: false, error: 'request_failed' }), 'failed');
    assert.equal(guestCheckStatus({ inNetwork: false, error: null }), 'checked');
    assert.equal(sunfireCheckStatus({ labels: [], error: 'skipped' }), 'unchecked');
    assert.equal(sunfireCheckStatus({ labels: [], error: null }), 'unchecked'); // never answered
    assert.equal(sunfireCheckStatus({ labels: [], error: 'timeout' }), 'failed');
    assert.equal(sunfireCheckStatus({ labels: [], error: null, ran: true }), 'checked');
  });

  const ask = 'Client ZIP 33018. Compare Aetna Medicare Select Care H1609-093, Wellcare Dual Align Unity H1032-250 and Simply Complete Platinum H5471-125';
  const doc = (name, statuses) => ({
    requestedName: name, doctorName: name, npi: '1111111111', status: 'done', pending: [], failed: [],
    inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [],
    networks: [
      { carrier: 'Aetna Medicare', inNetwork: false, status: statuses.aetna },
      { carrier: 'Wellcare', inNetwork: false, status: statuses.wellcare },
      { carrier: 'Simply Healthcare', inNetwork: false, status: statuses.simply },
    ],
  });
  const row = (out, who) => out.split('\n').find((l) => l.includes(who)).split('|').slice(2, 5).map((c) => c.trim());

  it('no lookup ran → ❔ unchecked on all three, never Out', () => {
    const out = N.fallbackAnswer([doc('Ana Ruiz', { aetna: 'unchecked', wellcare: 'unchecked', simply: 'unchecked' })], ask);
    assert.deepEqual(row(out, 'Ana Ruiz'), ['❔ unchecked', '❔ unchecked', '❔ unchecked']);
    assert.doesNotMatch(out.split('\n').find((l) => l.includes('Ana Ruiz')), /❌/);
  });

  it('lookup ran and did not list the doctor → ❔ not confirmed (still never Out)', () => {
    const out = N.fallbackAnswer([doc('Ana Ruiz', { aetna: 'checked', wellcare: 'checked', simply: 'checked' })], ask);
    assert.deepEqual(row(out, 'Ana Ruiz'), ['❔ not confirmed', '❔ not confirmed', '❔ not confirmed']);
  });

  it('a failed lookup reads ❔ unchecked', () => {
    const out = N.fallbackAnswer([doc('Ana Ruiz', { aetna: 'failed', wellcare: 'failed', simply: 'failed' })], ask);
    assert.deepEqual(row(out, 'Ana Ruiz'), ['❔ unchecked', '❔ unchecked', '❔ unchecked']);
  });

  it('Excel/PDF export puts no Out on plans whose lookup never ran', () => {
    const plans = [{ planId: 'H1609-093', carrier: 'Aetna', planName: 'Aetna Medicare Select Care' }, { planId: 'H1032-250', carrier: 'Wellcare', planName: 'Wellcare Dual Align Unity' }, { planId: 'H5471-125', carrier: 'Simply', planName: 'Simply Complete Platinum' }];
    const rows = E.doctorsFromProviderLookups([{ output: doc('Ana Ruiz', { aetna: 'unchecked', wellcare: 'unchecked', simply: 'unchecked' }) }], plans);
    assert.equal(rows.length, 1);
    for (const s of rows[0].statuses) assert.notEqual(s, E.NETWORK_OUT);
  });
});
