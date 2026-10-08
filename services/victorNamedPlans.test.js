const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { namedPlanColumns, selectComparison, gridTable } = require('./doctorPlanNarrow');
const { resolveNpiRecords } = require('./npiRegistry');
const { normalizeInput } = require('./compareJobs');

// Victor Rocha, ZIP 33143 (2026-10-08): five plans named by ID only. Every CarePlus and Doctors
// cell read "❔ not confirmed" although the lookups listed Marcus St John (CarePlus p62 + Doctors)
// and Armando J Rivero (Doctors). The plan-ID-only columns had no carrier, so carrier hits never landed.
const doc = (name, matched, npi, carriersIn) => ({
  requestedName: name, doctorName: matched, npi, status: 'done', pending: [], failed: [],
  inNetworkPlans: [...carriersIn], outOfNetworkPlans: [], carriersIn: [...carriersIn],
  networks: [
    { carrier: 'CarePlus', inNetwork: carriersIn.includes('CarePlus'), status: 'checked', partialList: true, directoryMatches: [] },
    { carrier: 'Doctors HealthCare Plans', inNetwork: carriersIn.includes('Doctors HealthCare Plans'), status: 'checked' },
  ],
});
const marcus = doc('Marcus St John', 'MARCUS E ST JOHN MD', '1073510269', ['CarePlus', 'Doctors HealthCare Plans']);
const armando = doc('Armando J Rivero', 'ARMANDO J RIVERO MD', '1982668323', ['Doctors HealthCare Plans']);
const ids = ['H1036-054C', 'H5420-001', 'H1019-006', 'H1019-136', 'H4140-022'];
const byId = ids.map((id) => ({ planId: id, name: id }));

describe('plans named by ID only take their carrier from the THEI grid', () => {
  it('CarePlus and Doctors carrier hits land as In', () => {
    const cols = namedPlanColumns(byId, [], [marcus, armando]);
    const col = (id) => cols.find((c) => c.planId === id);
    assert.equal(col('H1019-006').carrier, 'CarePlus');
    assert.equal(col('H4140-022').carrier, 'Doctors HealthCare');
    assert.deepEqual(col('H1019-006').in, ['Marcus St John']);
    assert.deepEqual(col('H1019-136').in, ['Marcus St John']);
    assert.deepEqual(col('H4140-022').in, ['Marcus St John', 'Armando J Rivero']);
    // CarePlus partial list: Armando not listed → not confirmed, never Out.
    assert.deepEqual(col('H1019-006').notConfirmed, ['Armando J Rivero']);
    assert.equal(col('H1019-006').out.length, 0);
  });

  it('the rendered table shows ✅ In, not ❔ not confirmed', () => {
    const sel = selectComparison([marcus, armando], 'ZIP 33143 No Medicaid.', { named: byId });
    const table = gridTable(sel.doctors, sel.columns);
    const marcusRow = table.split('\n').find((l) => /St John/.test(l));
    assert.equal((marcusRow.match(/✅ In/g) || []).length, 3, marcusRow);
  });

  it('a compare job keeps all five named plans (cap matches the UI’s 6)', () => {
    const input = normalizeInput({ zip: '33143', doctors: [{ name: 'Marcus St John' }], plans: ids });
    assert.deepEqual(input.plans, ids);
  });
});

describe('Carlos Santa-Cruz is never Carlos A Cruz', () => {
  it('a full middle word the match lacks flags the match', () => {
    const wrong = doc('Carlos Santa Cruz', 'CARLOS A CRUZ MD', '1679505259', []);
    const sel = selectComparison([wrong], 'ZIP 33143', { named: byId });
    assert.equal(sel.doctors[0].identityPending, 'mismatch');
    // A middle initial that agrees stays fine.
    const ok = doc('Armando Jose Rivero', 'ARMANDO J RIVERO MD', '1982668323', ['Doctors HealthCare Plans']);
    assert.equal(selectComparison([ok], 'ZIP 33143', { named: byId }).doctors[0].identityPending, '');
  });

  it('NPPES search tries the hyphenated compound before splitting the name', async () => {
    const person = (n, first, mid, last) => ({ number: n, enumeration_type: 'NPI-1', basic: { first_name: first, middle_name: mid, last_name: last, credential: 'MD' }, addresses: [{ address_purpose: 'LOCATION', postal_code: '331340000', state: 'FL' }], taxonomies: [{ primary: true, desc: 'Urology' }] });
    const DIR = [person('2222222222', 'CARLOS', '', 'SANTA-CRUZ'), person('1679505259', 'CARLOS', 'A', 'CRUZ')];
    const saved = global.fetch;
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      const last = (q.get('last_name') || '').toUpperCase();
      const first = (q.get('first_name') || '').toUpperCase();
      const results = q.get('enumeration_type') === 'NPI-2' ? [] : DIR.filter((r) => r.basic.last_name === last && (!first || r.basic.first_name === first));
      return { ok: true, json: async () => ({ results }) };
    };
    try {
      const r = await resolveNpiRecords({ doctorName: 'Carlos Santa Cruz', zip: '33143' });
      assert.equal(r[0].number, '2222222222');
    } finally { global.fetch = saved; }
  });
});
