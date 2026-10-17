// Robin Forte, 2026-10-17 12:06 PM ET (after #231 went live): De La Guarda (NPI 1447909296) still read ❔ unchecked on
// both Doctors plans. Railway logs: all 12 live Doctors calls that turn (De La Guarda + Espinoza × pcp/spe × 3 tries)
// failed "UND_ERR_SOCKET other side closed" within ~9 s; no 404, no deadline cut. Glinos read ✅ only because his NPI is
// in the 2027 Miami-Dade directory PDF (no live call). From another network the same calls answer 200 with 0 rows.
process.env.MAX_DOCTORS_HCP_RETRY_MS = '1';
process.env.MAX_DOCTORS_HCP_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert');
const D = require('./doctorsHcp');

const DE_LA_GUARDA = '1447909296';
const GLINOS = '1881199586';
const ESPINOZA = '1932274826';
function droppingFetch(fn) {
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' }; throw e; };
  return fn(() => calls).finally(() => { global.fetch = orig; });
}

test('live search unreachable + her county PDF does not list the NPI: checked "not listed" with the PDF date', async () => {
  D._resetForTests();
  await droppingFetch(async () => {
    const r = await D.queryDoctorsHcp(DE_LA_GUARDA, { zip: '33176' });
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.inNetwork, false);
    assert.strictEqual(r.source, 'pdf_miss');
    assert.strictEqual(r.liveUnreachable, true);
    assert.match(String(r.pdfAsOf), /October 1, 2026/);
    assert.deepStrictEqual(r.pdfCounties, ['Miami-Dade', 'Broward']);
  });
});

test('an NPI in the county PDF is In without a live call (Glinos)', async () => {
  D._resetForTests();
  await droppingFetch(async (calls) => {
    const r = await D.queryDoctorsHcp(GLINOS, { zip: '33176' });
    assert.strictEqual(r.inNetwork, true);
    assert.strictEqual(calls(), 0);
  });
});

test('no ZIP (no county PDF to fall back on): still a failed check, never ❌', async () => {
  D._resetForTests();
  await droppingFetch(async () => {
    const r = await D.queryDoctorsHcp(DE_LA_GUARDA, {});
    assert.strictEqual(r.error, 'request_failed');
  });
});

test('after a run of dropped connections the live search is skipped for a cool-down (no more load, fast answer)', async () => {
  D._resetForTests();
  await droppingFetch(async (calls) => {
    await D.queryDoctorsHcp(DE_LA_GUARDA, { zip: '33176' });
    const after = calls();
    assert.ok(after >= 4 && after <= 6, `calls ${after}`);
    assert.strictEqual(D.liveSearchDown(), true);
    const r = await D.queryDoctorsHcp(ESPINOZA, { zip: '33176' });
    assert.strictEqual(calls(), after, 'no live call while the breaker is open');
    assert.strictEqual(r.source, 'pdf_miss');
  });
});

test('a 200 with no rows is a plain checked miss (not a failure)', async () => {
  D._resetForTests();
  const orig = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  try {
    const r = await D.queryDoctorsHcp(DE_LA_GUARDA, { zip: '33176' });
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.inNetwork, false);
    assert.notStrictEqual(r.source, 'pdf_miss');
  } finally { global.fetch = orig; }
});
