// Robin Forte, 2026-10-17 11:51 AM ET: saved workup (ZIP 33176, Miami-Dade; Stephanie Sasha De La Guarda NPI 1447909296,
// George Demetrios Glinos NPI 1881199586; current plan H5420-001) + "Compare it to Doctors Health Plan and Human Gold".
// Prod showed only Doctors HealthCare (Humana dropped: "Human Gold" matched no carrier), the header said "top 3 … from 2
// eligible", and De La Guarda read ❔ on both Doctors plans (every Doctors API call from Railway: HTTP 404 / socket closed).
process.env.MAX_DOCTORS_HCP_RETRY_MS = '1';
process.env.MAX_DOCTORS_HCP_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');
const W = require('../artifacts/client-workups.js');
const { conversationAskText } = require('./planYear');
const D = require('./doctorsHcp');

const ASK = 'Compare it to Doctors Health Plan and Human Gold';
const WORKUP = {
  clientName: 'Robin Forte', zip: '33176', county: 'Miami-Dade', currentPlanIds: ['H5420-001'],
  plans: [{ carrier: 'UHC', planName: 'MedicareMax FL-0028', planId: 'H5420-001' }],
  doctors: [{ name: 'Stephanie Sasha De La Guarda', npi: '1447909296' }, { name: 'George Demetrios Glinos', npi: '1881199586' }],
  medications: [],
};
const DOCS = require('./fixtures/robinForteDoctors.json');

test('"Doctors Health Plan and Human Gold" names both carriers', () => {
  assert.deepStrictEqual(R.carriersRequested(ASK), ['Doctors HealthCare', 'Humana']);
  for (const t of ['compare humanna and solis', 'Compare it to Humna Gold Plus', 'Compare to Human Gold Plus']) assert.ok(R.carriersRequested(t).includes('Humana'), t);
  // Bare "human" is not Humana.
  assert.deepStrictEqual(R.carriersRequested('compare it, she is a human being'), []);
});

test('the loaded workup turn asks for both carriers and keeps her current plan', () => {
  const msgs = W.messagesForApi([{ role: 'user', content: ASK }], WORKUP);
  const askText = N.comparisonAskText(msgs, conversationAskText(msgs));
  assert.match(askText, /^Carriers requested: Doctors HealthCare, Humana\.$/m);
  assert.match(askText, /^Her current plan: H5420-001/m);
  assert.doesNotMatch(askText, /Carriers not recognized/);
});

test('table has her current plan + each named carrier, header does not claim a missing top 3', () => {
  const both = N.renderedAnswer(DOCS, 'Her current plan: H5420-001.\nZIP/county: 33176 / Miami-Dade\nCarriers requested: Doctors HealthCare, Humana.', {});
  const head = both.split('\n').find((l) => /^\| Doctor/.test(l));
  assert.match(head, /H5420-001/);
  assert.match(head, /H4140-02[23]/);
  assert.match(head, /Humana[^|]*H1036-/);
  const askOne = 'Her current plan: H5420-001.\nZIP/county: 33176 / Miami-Dade\nCarriers requested: Doctors HealthCare.';
  // The grid message carries no "Why these plans" paragraph and no tagline (Yahoska: "TOO MUCH TEXT").
  const one = N.renderedAnswer(DOCS, askOne, {});
  assert.doesNotMatch(one, /Why these plans|Excluded:|a count, not a recommendation/);
  assert.match(one.split('\n')[0], /^\*\*Doctors × Doctors HealthCare\*\*$/);
  // The model's summary still knows why (if she asks), without claiming a missing top 3.
  const why = N.selectComparison(DOCS, askOne, {}).whyLine;
  assert.doesNotMatch(why, /top 3 eligible Doctors HealthCare plans from 2/);
  assert.match(why, /all 2 eligible Doctors HealthCare plans/);
});

test('a carrier name that matches nothing is said, never dropped silently', () => {
  assert.deepStrictEqual(R.carriersUnresolved('Compare it to Doctors Health Plan and Xyz Care'), ['Xyz Care']);
  assert.deepStrictEqual(R.carriersUnresolved(ASK), []);
  assert.deepStrictEqual(R.carriersUnresolved('show me Dr. Glinos results'), []);
  const msgs = W.messagesForApi([{ role: 'user', content: 'Compare it to Doctors Health Plan and Xyz Care' }], WORKUP);
  const askText = N.comparisonAskText(msgs, conversationAskText(msgs));
  assert.match(askText, /^Carriers not recognized: Xyz Care\.$/m);
  const out = N.renderedAnswer(DOCS, askText, {});
  assert.match(out, /Couldn't match "Xyz Care" to a carrier/);
});

const NPI = '1447909296';
const okList = (npi) => ({ ok: true, status: 200, json: async () => (npi ? [{ providerNpi: npi, providerName: 'DE LA GUARDA', providerAddress1: '1 Main', providerSpecialties: 'Family Medicine' }] : []) });
function withFetch(seq, fn) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.ProviderType);
    const step = seq.shift() || 'ok';
    if (step === 'socket') { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' }; throw e; }
    if (step === '404') return { ok: false, status: 404, json: async () => ({}) };
    if (step === 'miss') return okList(null);
    return okList(NPI);
  };
  return fn(calls).finally(() => { global.fetch = orig; });
}

test('Doctors HealthCare: a dropped socket and a 404 are retried, and the NPI match completes', async () => {
  D._resetForTests();
  await withFetch(['socket', '404', 'ok'], async (calls) => {
    const r = await D.queryDoctorsHcp(NPI, { zip: '' });
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.inNetwork, true);
    assert.strictEqual(calls.length, 3);
  });
});

test('Doctors HealthCare: still failing after retries is a failed check (❔), never "not in network"', async () => {
  D._resetForTests();
  await withFetch(['socket', 'socket', 'socket', 'socket', 'socket', 'socket'], async () => {
    const r = await D.queryDoctorsHcp(NPI, { zip: '' });
    assert.strictEqual(r.error, 'request_failed');
    assert.strictEqual(r.inNetwork, false);
  });
});

test('Doctors HealthCare: the same NPI asked twice at once is one check', async () => {
  D._resetForTests();
  await withFetch(['ok', 'ok', 'ok', 'ok'], async (calls) => {
    const [a, b] = await Promise.all([D.queryDoctorsHcp(NPI, { zip: '' }), D.queryDoctorsHcp(NPI, { zip: '' })]);
    assert.strictEqual(a.inNetwork, true);
    assert.strictEqual(b.inNetwork, true);
    assert.strictEqual(calls.length, 1);
  });
});
