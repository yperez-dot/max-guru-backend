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

describe('"check Doctors DrMax-Dade · H4140-022 again" then "add Humana … and UHC …" (Victor, 9:45–9:48 AM)', () => {
  const { comparisonAskText } = require('./doctorPlanNarrow');
  const { conversationAskText } = require('./planYear');
  const msgs = [
    { role: 'user', content: 'Victor Rocha 33143. Compare Humana Gold Plus H1036-054C, UHC MedicareMax FL-0028 H5420-001, CarePlus CareOne Plus H1019-006, CarePlus H1019-136, Doctors DrMax-Dade H4140-022' },
    { role: 'assistant', content: 'table' },
    { role: 'user', content: 'check Doctors DrMax-Dade · H4140-022 again' },
    { role: 'assistant', content: 'table' },
    { role: 'user', content: 'Pls add Humana Humana Gold Plus · H1036-054C and UHC MedicareMax MA FL-0028 HMO · H5420-001 to the grid' },
  ];
  it('the column is named "Doctors DrMax-Dade", never "check Doctors DrMax-Dade"', () => {
    const ask = comparisonAskText(msgs, conversationAskText(msgs));
    const sel = selectComparison([marcus], ask);
    assert.deepEqual(sel.columns.map((c) => c.planId), ['H4140-022', 'H1036-054C', 'H5420-001']);
    const drmax = sel.columns.find((c) => c.planId === 'H4140-022');
    assert.doesNotMatch(drmax.name, /^check\b/i);
    assert.match(drmax.name, /Doctors DrMax-Dade/);
  });
});

describe('Excel export doctor rows (Victor’s Plan_Comparison_H1036-054C_H5420-001.xlsx)', () => {
  const exp = require('../artifacts/comparison-export.js');
  const plans = [{ planId: 'H5420-001', carrier: 'UnitedHealthcare', planName: 'UHC MedicareMax FL-0028', county: 'Miami-Dade' }];
  const uhc = (inNetwork) => [{ carrier: 'UnitedHealthcare', inNetwork, status: 'checked', plans: inNetwork ? ['UHC MedicareMax FL-0028 (H5420-001)'] : [], outOfNetworkPlans: inNetwork ? [] : ['UHC MedicareMax FL-0028 (H5420-001)'] }];

  it('her name never sits on a different doctor’s NPI; his In/Out does not count', () => {
    const [row] = exp.doctorsFromProviderLookups([{ doctorName: 'CARLOS A CRUZ MD', requestedName: 'Dr. Carlos Santa Cruz', npi: '1679505259', networks: uhc(false) }], plans);
    assert.match(row.name, /Carlos A Cruz \(you asked Carlos Santa Cruz\)/);
    assert.match(row.name, /confirm match/);
    assert.equal(row.statuses[0], 'Not confirmed');
  });

  it('a partial name she typed ("Marcus St") shows the full registry name', () => {
    const [row] = exp.doctorsFromProviderLookups([{ doctorName: 'MARCUS E ST JOHN MD', requestedName: 'Marcus St', npi: '1073510269', networks: uhc(true) }], plans);
    assert.equal(row.name, 'Dr. Marcus E St John');
    assert.equal(row.statuses[0], 'In network');
  });

  it('a matching middle initial is the same person', () => {
    const [row] = exp.doctorsFromProviderLookups([{ doctorName: 'ARMANDO J RIVERO MD', requestedName: 'Armando Jose Rivero', networks: uhc(true) }], plans);
    assert.equal(row.statuses[0], 'In network');
  });
});

describe('a loaded workup’s meds are priced ("it didnt add his meds either")', () => {
  const R = require('./comparisonRules');
  it('reads the workup "Medications (…):" bullet list, without the saved tier text', () => {
    const t = 'LOADED CLIENT WORKUP — structured facts only\nZIP: 33143\nMedications (tiers shown are verified formulary only; a med with no tier still needs lookup_formulary):\n- Atorvastatin 20mg: H1036-054C Tier 1 · $0\n- Tamsulosin 0.4mg\nNeeds:\n- dental';
    assert.deepEqual(R.medsFromAsk(t), ['Atorvastatin 20mg', 'Tamsulosin 0.4mg']);
  });
  it('the one-line form still works', () => {
    assert.deepEqual(R.medsFromAsk('Meds: Metformin 500mg, Lisinopril 10mg'), ['Metformin 500mg', 'Lisinopril 10mg']);
  });
});

describe('MedicarePro "Prescriptions (5)" paste (Victor, 9:54 AM)', () => {
  const R = require('./comparisonRules');
  const { parseCompareAsk } = require('./compareJobs');
  const rx = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/victorPrescriptions.txt'), 'utf8');
  const want = ['Atorvastatin Calcium 10mg', 'Ezetimibe 10mg', 'Pantoprazole Sodium 20mg', 'Tadalafil 2.5mg', 'Tamsulosin HCl 0.4mg'];
  it('chat reads all 5 meds with strengths', () => assert.deepEqual(R.medsFromAsk(rx), want));
  it('the new-client form reads all 5 too', () => assert.deepEqual(parseCompareAsk(`Victor Rocha 33143\n${rx}`).meds, want));
});

describe('the exact text pasted into New client (Victor, 9:57 AM)', () => {
  const { parseCompareAsk } = require('./compareJobs');
  const text = [
    'New client: Victor Rocha, ZIP 33143 (Miami-Dade), 2027.',
    'Doctors: Carlos Santa-Cruz, MD (Urology, Coral Gables); Marcus St John NPI 1073510269; Armando J Rivero NPI 1982668323',
    'Meds: atorvastatin calcium 10mg, ezetimibe 10mg, pantoprazole sodium 20mg DR, tadalafil 2.5mg, tamsulosin HCl 0.4mg',
    'Compare Humana Gold Plus H1036-054C, UHC MedicareMax FL-0028 H5420-001, CarePlus CareOne Plus H1019-006, CarePlus CareFree Platinum H1019-136, Doctors DrMax-Dade H4140-022',
  ].join('\n');
  it('finds the name after a "New client:" label', () => {
    assert.equal(parseCompareAsk(text).clientName, 'Victor Rocha');
    assert.equal(parseCompareAsk('Client: Maria Gonzalez, ZIP 33178').clientName, 'Maria Gonzalez');
  });
  it('3 doctors (not 5): parenthetical commas and a trailing credential are not doctors', () => {
    const r = parseCompareAsk(text);
    assert.deepEqual(r.doctors.map((d) => d.name), ['Carlos Santa-Cruz', 'Marcus St John', 'Armando J Rivero']);
    assert.equal(r.doctors[1].npi, '1073510269');
  });
  it('5 meds and 5 plans', () => {
    const r = parseCompareAsk(text);
    assert.equal(r.meds.length, 5);
    assert.equal(r.plans.length, 5);
  });
});

describe('opening another client’s workup drops the previous client’s lookups (Gail’s PDF had Victor’s doctors and meds)', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  it('resetChatSession clears the session lookup results even when it keeps the workup', () => {
    const fn = html.slice(html.indexOf('const keepWorkup = opts && opts.keepWorkup;'), html.indexOf('setMessages([]);', html.indexOf('const keepWorkup = opts && opts.keepWorkup;')));
    const beforeIf = fn.slice(0, fn.indexOf('if (!keepWorkup)'));
    assert.match(beforeIf, /sessionToolResultsRef\.current = \[\]/);
    assert.match(beforeIf, /resumeToolResultsRef\.current = \[\]/);
  });
});

describe('an NPI she typed survives one dropped NPPES answer (Gail’s Rawan Jumean-Haddad)', () => {
  it('retries the NPI lookup, then finds him', async () => {
    process.env.NPPES_RETRY_DELAY_MS = '1';
    const saved = global.fetch;
    let calls = 0;
    global.fetch = async (url) => {
      calls += 1;
      if (calls <= 2) throw new Error('socket hang up');
      return { ok: true, json: async () => ({ results: [{ number: '1184715435', enumeration_type: 'NPI-1', basic: { first_name: 'RAWAN', middle_name: 'H', last_name: 'JUMEAN', credential: 'MD' }, addresses: [{ address_purpose: 'LOCATION', postal_code: '331860000', state: 'FL' }], taxonomies: [{ primary: true, desc: 'Rheumatology' }] }] }) };
    };
    try {
      const r = await resolveNpiRecords({ doctorName: 'Rawan Jumean-Haddad', npi: '1184715435', zip: '33186' });
      assert.equal(r[0].number, '1184715435');
      assert.equal(calls, 3);
    } finally { global.fetch = saved; }
  });
});
