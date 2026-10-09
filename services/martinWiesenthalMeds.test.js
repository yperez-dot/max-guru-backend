// Martin Wiesenthal, 2026-10-09 (ZIP 33324, Broward, 2027): the doctors table rendered for
// H1019-001 / H5431-006 / H0982-007, but "Medications (2027)" showed only a legend line.
//   - "Medications esomeprazole, …" (no colon) read 0 meds, so nothing was priced, and the model's
//     own meds table had its rows stripped, leaving a heading and a legend over nothing.
//   - "rasuvostatin" resolved to Rasuvo (methotrexate) via medicare.gov autocomplete.
//   - "acyclovir tablets & ointment" was one oral-tablet row.
//   - esomeprazole read "not covered" from OTC tablets and esomeprazole/naproxen (Vimovo) NDCs.
// RxNorm / medicare.gov are stubbed with the shapes they returned live that day.
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.SUNFIRE_JWT; // Sunfire is not part of this repro (no creds in tests)

const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const C = require('./compareJobs');
const F = require('./formularyLookup');
const D = require('./drugNames');
const { conversationAskText } = require('./planYear');

const ASK = 'Martin Wiesenthal, Zip 33324, Dr.Steven Barilla, Dr. Matthew Soff, Dr. Zuhdiyah Darojat, Medications esomeprazole, rasuvostatin, tadalafil, trazodone, acyclovir tablets & ointment.';
const PLANS = ['H1019-001', 'H5431-006', 'H0982-007'];
const MEDS = ['esomeprazole', 'rasuvostatin', 'tadalafil', 'trazodone', 'acyclovir tablets', 'acyclovir ointment'];

// ─── stub RxNorm + medicare.gov ────────────────────────────────────────────────

const EXACT = { esomeprazole: '283742', tadalafil: '358263', trazodone: '82112', acyclovir: '281', rosuvastatin: '301542', testamol: '999001' };
const CONCEPTS = {
  283742: [
    ['433733', 'esomeprazole 20 MG Delayed Release Oral Tablet'], // OTC (Nexium 24HR store brands)
    ['994005', 'esomeprazole 20 MG / naproxen 375 MG Delayed Release Oral Tablet'], // Vimovo
    ['606726', 'esomeprazole 20 MG Delayed Release Oral Capsule'], // the Rx product
  ],
  301542: [['859424', 'rosuvastatin calcium 10 MG Oral Tablet']],
  // RxNorm's tadalafil products (live): one per strength, plus the PAH-named 20 mg product.
  358263: [
    ['757707', 'tadalafil 2.5 MG Oral Tablet'], ['403957', 'tadalafil 5 MG Oral Tablet'], ['484814', 'tadalafil 10 MG Oral Tablet'],
    ['402019', 'tadalafil 20 MG Oral Tablet'], ['2123194', 'Pulmonary Hypertension tadalafil 20 MG Oral Tablet'],
  ],
  82112: [['856364', 'trazodone hydrochloride 50 MG Oral Tablet']],
  281: [['197311', 'acyclovir 400 MG Oral Tablet'], ['197312', 'acyclovir 0.05 MG/MG Topical Ointment']],
  1544379: [['1544383', '0.2 ML methotrexate 50 MG/ML Auto-Injector [Rasuvo]']],
  // Made-up drug: two products at the same strength that disagree on coverage.
  999001: [['999011', 'testamol 10 MG Oral Tablet'], ['999012', 'testamol 10 MG Oral Capsule']],
};
const NDCS = { 433733: ['00363036142'], 994005: ['76420089030'], 606726: ['00093645056'], 859424: ['00093744898'], 757707: ['00093301630'], 403957: ['00093301730'], 484814: ['13668056730'], 402019: ['13668056830'], 2123194: ['13668058130'], 856364: ['00378347301'], 197311: ['00378025301'], 197312: ['00472008216'], 1544383: ['59137050504'], 999011: ['99900000011'], 999012: ['99900000012'] };
const OTC = new Set(['00363036142']);
// medicare.gov drug cost answers on H1019-001 2027 (live, 2026-10-09).
const COST = {
  '00093645056': { tier: 3, covered: true }, // esomeprazole DR capsule
  '76420089030': { covered: false, reason: 'NOT_COVERED' }, // Vimovo
  '00093744898': { tier: 1, covered: true },
  '00093301630': { covered: false, reason: 'NOT_IN_FORMULARY' }, // tadalafil 2.5 mg
  '00093301730': { tier: 4, covered: true }, // tadalafil 5 mg
  '13668056730': { covered: false, reason: 'NOT_IN_FORMULARY' }, // tadalafil 10 mg
  '13668056830': { covered: false, reason: 'NOT_IN_FORMULARY' }, // tadalafil 20 mg
  '13668058130': { tier: 4, covered: true }, // tadalafil 20 mg (PAH)
  '00378347301': { tier: 1, covered: true },
  '00378025301': { tier: 1, covered: true },
  '00472008216': { covered: false, reason: 'NOT_COVERED' },
  '99900000011': { tier: 2, covered: true }, // testamol tablet
  '99900000012': { covered: false, reason: 'NOT_IN_FORMULARY' }, // testamol capsule
};

function stubFetch(log) {
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, opts = {}) => {
    const u = String(url);
    const q = (k) => decodeURIComponent((u.match(new RegExp(`[?&]${k}=([^&]+)`)) || [])[1] || '').replace(/\+/g, ' ');
    if (/\/drugs\/cost$/.test(u)) {
      // Many NDCs x many plans per request, like medicare.gov. Solis (H0982) is not in its data.
      const body = JSON.parse(opts.body);
      const ndcs = body.prescriptions.map((x) => x.ndc);
      if (ndcs.length === 1) log.push(ndcs[0]);
      const plans = body.plans.filter((pl) => pl.contract_id !== 'H0982').map((plan) => ({
        plan,
        costs: [{ drug_costs: ndcs.filter((n) => COST[n]).map((n) => ({ ndc: n, tier: COST[n].tier || null, covered: COST[n].covered, coverage_reason: COST[n].reason || 'COVERED' })) }],
        restrictions: [],
        excluded_drugs: [],
      }));
      return json({ plans });
    }
    if (u.includes('/rxcui.json?name=')) {
      const id = EXACT[q('name')];
      return json({ idGroup: id ? { rxnormId: [id] } : {} });
    }
    if (u.includes('/approximateTerm.json')) {
      if (q('term') === 'rasuvostatin') return json({ approximateGroup: { candidate: [{ rxcui: '301542', name: 'rosuvastatin', source: 'RXNORM', score: '8.31', rank: '1' }] } });
      if (q('term') === 'metoprozol') {
        return json({ approximateGroup: { candidate: [
          { rxcui: '6918', name: 'metoprolol', source: 'RXNORM', score: '8.0', rank: '1' },
          { rxcui: '7646', name: 'omeprazole', source: 'RXNORM', score: '7.9', rank: '2' },
        ] } });
      }
      return json({ approximateGroup: {} });
    }
    if (/\/related\.json\?tty=IN$/.test(u)) return json({ relatedGroup: { conceptGroup: [] } });
    if (u.includes('/drugs/autocomplete')) {
      const name = q('name');
      // medicare.gov's prefix match: "rasuvostatin" → Rasuvo (methotrexate). Must never be used.
      if (name.startsWith('rasuvo')) return json({ drugs: [{ rxcui: '1544379', name: 'Rasuvo' }] });
      const id = EXACT[name];
      return json({ drugs: id ? [{ rxcui: id, name }] : [] });
    }
    const rel = u.match(/\/rxcui\/(\d+)\/related\.json\?tty=SCD/);
    if (rel) return json({ relatedGroup: { conceptGroup: [{ tty: 'SCD', conceptProperties: (CONCEPTS[rel[1]] || []).map(([rxcui, name]) => ({ rxcui, name, tty: 'SCD' })) }] } });
    const nd = u.match(/\/rxcui\/(\d+)\/ndcs\.json/);
    if (nd) return json({ ndcGroup: { ndcList: { ndc: NDCS[nd[1]] || [] } } });
    if (u.includes('/ndcproperties.json')) {
      const id = q('id');
      return json({ ndcPropertyList: { ndcProperty: [{ propertyConceptList: { propertyConcept: [{ propName: 'LABEL_TYPE', propValue: OTC.has(id) ? 'HUMAN OTC DRUG' : 'HUMAN PRESCRIPTION DRUG' }] } }] } });
    }
    return json({}, 404);
  };
}

async function priceAll(meds, planIds = ['H1019-001'], log = []) {
  D._nameCache.clear();
  const fetchImpl = stubFetch(log);
  const out = [];
  for (const drugName of meds) out.push(await F.lookupFormulary({ drugName, planIds, year: 2027 }, fetchImpl));
  return out;
}

// ─── parsing: the exact string she typed ─────────────────────────────────────

test('chat path reads all six meds from her exact message (label without a colon, forms split)', () => {
  const msgs = [{ role: 'user', content: ASK }];
  const askText = N.comparisonAskText(msgs, conversationAskText(msgs));
  assert.deepEqual(R.medsFromAsk(askText), MEDS);
  assert.deepEqual(R.medsFromAsk(ASK), MEDS);
});

test('comparison queue reads the same six meds from her exact message', () => {
  const f = C.parseCompareAsk(ASK);
  assert.equal(f.zip, '33324');
  assert.deepEqual(f.meds, MEDS);
  // "Dr.Steven" (no space) and "Dr. Matthew" read as doctors with no "Doctors:" label.
  assert.deepEqual(f.doctors.map((d) => d.name), ['Steven Barilla', 'Matthew Soff', 'Zuhdiyah Darojat']);
  assert.equal(f.clientName, 'Martin Wiesenthal');
  // Spanish titles.
  const es = C.parseCompareAsk('Carmen Diaz, 33130, Dra. Ana Ruiz, Dra.María López y Dr. Jorge G. Ruiz. Medicamentos: metformina.');
  assert.deepEqual(es.doctors.map((d) => d.name), ['Ana Ruiz', 'María López', 'Jorge G. Ruiz']);
  assert.deepEqual(es.meds, ['metformina']);
  assert.deepEqual(C.normalizeInput({ zip: '33324', meds: ['acyclovir tablets & ointment'] }).meds, ['acyclovir tablets', 'acyclovir ointment']);
});

test('labels in English and Spanish, with or without a colon; non-lists are not meds', () => {
  assert.deepEqual(R.medsFromAsk('Medicamentos: metformina y lisinopril. Compare H1019-001'), ['metformina', 'lisinopril']);
  assert.deepEqual(R.medsFromAsk('Medicinas metformina, lisinopril'), ['metformina', 'lisinopril']);
  assert.deepEqual(R.medsFromAsk('Takes Eliquis. ZIP 33324'), ['Eliquis']);
  assert.deepEqual(R.medsFromAsk('Rx atorvastatin, losartan'), ['atorvastatin', 'losartan']);
  assert.deepEqual(R.medsFromAsk('Meds: acyclovir tabs and cream'), ['acyclovir tabs', 'acyclovir cream']);
  assert.deepEqual(R.medsFromAsk('Discard any client-stated Rx tiers. Call lookup_formulary for any unverified drug × named plan.'), []);
  assert.deepEqual(R.medsFromAsk('No meds. ZIP 33324, Dr. Jane Smith'), []);
  assert.deepEqual(R.medsFromAsk('Meds already on file, do not ask again.'), []);
  assert.deepEqual(R.medsFromAsk('ZIP 33018.\nHer current plan: H1045-001.\nRank all eligible plans.'), []);
});

test('unlabeled list after the doctors still reads (ported unlabeledMeds)', () => {
  assert.deepEqual(R.medsFromAsk(ASK.replace('Medications ', '')), MEDS);
});

test('dosage forms are separate items and separate drugs', () => {
  assert.deepEqual(D.expandDosageForms('acyclovir tablets & ointment'), ['acyclovir tablets', 'acyclovir ointment']);
  assert.ok(!R.sameDrug('acyclovir tablets', 'acyclovir ointment'));
  assert.ok(R.sameDrug('atorvastatin', 'Atorvastatin Calcium 20 MG'));
});

// ─── lookups ─────────────────────────────────────────────────────────────────

test('every repro drug is priced on H1019-001 with the right product', async () => {
  const log = [];
  const [eso, rosu, tada, traz, acyTab, acyOint] = await priceAll(MEDS, ['H1019-001'], log);
  const row = (r) => r.byPlanId['H1019-001'];

  // esomeprazole: the Rx DR capsule (T3) — not the OTC tablet, not Vimovo.
  assert.equal(row(eso).coverage, 'covered');
  assert.equal(row(eso).tier, 3);
  assert.ok(!log.includes('00363036142'), 'OTC esomeprazole tablet NDC must not be priced');
  assert.ok(!log.includes('76420089030'), 'esomeprazole/naproxen (Vimovo) must not be priced for "esomeprazole"');

  // rasuvostatin → rosuvastatin, flagged; never Rasuvo (methotrexate).
  assert.deepEqual(rosu.nameCorrection, { from: 'rasuvostatin', to: 'rosuvastatin' });
  assert.equal(rosu.drugName, 'rosuvastatin');
  assert.equal(row(rosu).tier, 1);
  assert.ok(!log.includes('59137050504'), 'Rasuvo must never be priced');

  // tadalafil: looked up like any drug, labeled — not auto-excluded, not "not confirmed".
  assert.equal(row(tada).verified, true);
  assert.equal(row(tada).edLabel, D.ED_LABELS.verify);

  assert.equal(row(traz).tier, 1);

  // acyclovir: two products, two rows.
  assert.equal(acyTab.drugName, 'acyclovir oral tablet');
  assert.equal(row(acyTab).tier, 1);
  assert.equal(acyOint.drugName, 'acyclovir topical ointment');
  assert.equal(row(acyOint).coverage, 'not_covered');
  assert.ok(log.includes('00472008216'), 'ointment priced on the ointment NDC');
  assert.equal(log.filter((n) => n === '00378025301').length, 1, 'the oral tablet NDC is priced for the tablet only');
});

test('an ointment with no ointment product is "Not confirmed (form not found)" — never the oral form', async () => {
  const log = [];
  const [r] = await priceAll(['trazodone ointment'], ['H1019-001'], log);
  assert.equal(r.byPlanId['H1019-001'].verified, false);
  assert.match(r.byPlanId['H1019-001'].reason, /form_not_found/);
  assert.deepEqual(log, [], 'no oral NDC may be priced for an ointment ask');
  const table = N.medsTable([r], [{ planId: 'H1019-001', name: 'CarePlus CareOne Plus' }]);
  assert.match(table, /❔ not confirmed \(form not found\)/);
});

test('competing ingredients: no pricing, ask "did you mean …?"', async () => {
  const log = [];
  const [r] = await priceAll(['metoprozol'], ['H1019-001'], log);
  assert.equal(r.nameCheck.status, 'ambiguous');
  assert.equal(r.nameCheck.suggestion, 'metoprolol');
  assert.deepEqual(log, [], 'an unclear name is never priced');
  const table = N.medsTable([r], [{ planId: 'H1019-001', name: 'CarePlus CareOne Plus' }]);
  assert.match(table, /❓ 'metoprozol' — did you mean metoprolol\?/);
  assert.match(table, /❓ check name/);
});

test('ED drug labels', () => {
  assert.equal(D.edLabel({ verified: true, coverage: 'covered', excludedDrug: true }), D.ED_LABELS.supplemental);
  // A PA flag never implies the indication: Solis prints tadalafil 2.5 mg "PA, QL" with no BPH/PAH.
  assert.equal(D.edLabel({ verified: true, coverage: 'covered', pa: true }), 'Covered · PA required (verify indication)');
  assert.equal(D.edLabel({ verified: true, coverage: 'covered', pa: true, indication: 'PAH' }), D.ED_LABELS.bphPah);
  assert.equal(D.edLabel({ verified: true, coverage: 'covered' }), 'Covered — verify if supplemental benefit');
  assert.equal(D.edLabel({ verified: true, coverage: 'not_covered' }), 'Not covered by this plan');
  assert.equal(D.edLabel({ verified: false }), 'Not confirmed');
  for (const n of ['tadalafil', 'sildenafil 20mg', 'vardenafil', 'avanafil', 'Viagra']) assert.ok(D.isEdDrug(n), n);
  assert.ok(!D.isEdDrug('trazodone'));
});

// ─── rendering ───────────────────────────────────────────────────────────────

const docs = [
  { requestedName: 'Steven Barilla', doctorName: 'Steven Barilla', status: 'done', pending: [], failed: [], networks: [], carriersIn: [],
    inNetworkPlans: ['CarePlus CareOne Plus (H1019-001)', 'HealthSun MediMax (H5431-006)', 'Solis Healthy Living (H0982-007)'], outOfNetworkPlans: [] },
];
const ASK_TEXT = `${ASK}\nCompare ${PLANS.join(', ')}.`;

test('full meds table: one row per drug and form, correction shown, ED label, PA/ST/QL flags', async () => {
  const drugs = await priceAll(MEDS, PLANS);
  const text = N.renderedAnswer(docs, ASK_TEXT, { drugs });
  assert.match(text, /\*\*Meds\*\*/);
  const rows = text.split('\n').filter((l) => /^\| /.test(l) && !/^\| (Doctor|Drug)\b/.test(l));
  const medRows = rows.filter((l) => /esomeprazole|rosuvastatin|tadalafil|trazodone|acyclovir/i.test(l));
  assert.equal(medRows.length, 6, medRows.join('\n'));
  assert.ok(medRows.some((l) => l.startsWith('| rasuvostatin → rosuvastatin (auto-corrected, verify) |')), medRows.join('\n'));
  assert.ok(medRows.some((l) => /^\| acyclovir oral tablet \|/i.test(l)), medRows.join('\n'));
  assert.ok(medRows.some((l) => /^\| acyclovir topical ointment \|/i.test(l)), medRows.join('\n'));
  // No strength typed: tadalafil splits by strength on CarePlus (only 5 mg and the PAH 20 mg are covered).
  assert.ok(medRows.some((l) => l.startsWith('| tadalafil | 2.5/10/20 mg: ❌ not covered ‖ 5 mg: T4 50% · PA/QL ? ‖ 20 mg (PAH): T4 50% · PA/QL ? |')), medRows.join('\n'));
  assert.ok(!/\| rasuvostatin \| ❔ unchecked/i.test(text), 'the typed name is answered by the corrected lookup');
  assert.doesNotMatch(text, /Medication lookup failed/);
  assert.match(R.MEDS_LEGEND, /PA = prior auth · ST = step therapy · QL = quantity limit/);
  const row = { verified: true, tier: 2, costShare: '$5', pa: true, st: true, ql: true };
  assert.equal(N.medsTable([{ drugName: 'x', byPlanId: { 'H1019-001': row }, lookups: [row] }], [{ planId: 'H1019-001', name: 'CarePlus' }]).split('\n')[2], '| x | T2 $5 · PA · ST · QL |');
});

test('every lookup failed: red banner, and drug cost does not rank plans', () => {
  const failed = MEDS.map((m) => ({ drugName: m, lookups: PLANS.map((id) => ({ planId: id, verified: false, reason: 'medicare_gov_http_0' })), byPlanId: Object.fromEntries(PLANS.map((id) => [id, { planId: id, verified: false, reason: 'medicare_gov_http_0' }])) }));
  const text = N.renderedAnswer(docs, ASK_TEXT, { drugs: failed });
  assert.match(text, /🛑 \*\*Medication lookup failed — do not rank by drug cost\*\*/);
  assert.match(text, /\| esomeprazole \| ❔ not confirmed/i);
  const sel = N.selectComparison(docs, ASK_TEXT, { drugs: failed });
  assert.ok(sel.columns.every((c) => c.drugCost == null));
});

test('model-written meds heading and legend never stand alone under the server table', () => {
  const rendered = '**Doctors**\n\n| Doctor | H1019-001 |\n|---|---|\n| Steven Barilla | ✅ In |\n\n✅ In · ❔ unchecked = never checked';
  const reply = '**Medications (2027)**\n\n| Drug | H1019-001 |\n|---|---|\n| Esomeprazole | ❔ not confirmed |\n\n❔ not confirmed = checked, no result\nWant me to check her pharmacy?';
  const out = N.enforceRenderedTable(reply, rendered);
  assert.doesNotMatch(out, /Medications \(2027\)/);
  assert.doesNotMatch(out.slice(rendered.length), /❔ not confirmed = checked, no result/);
  assert.match(out, /Want me to check her pharmacy\?/);
});

test('doctors + drugs typed but no list read: warn instead of omitting the section', async () => {
  const hits = await D.drugTokensInText('Martin, 33324, Dr. Steven Barilla — esomeprazole tadalafil daily', {
    exclude: ['Steven Barilla'],
    fetchImpl: stubFetch([]),
  });
  assert.deepEqual(hits.sort(), ['esomeprazole', 'tadalafil']);
  const text = N.renderedAnswer(docs, `ZIP 33324. Compare ${PLANS.join(', ')}.`, { drugs: [], medsUnreadable: true });
  assert.match(text, /Couldn't read the medication list\. Re-send as 'Meds: a, b, c'/);
});

// ─── Solis H0982-007: indication and cost (2026-10-09 review) ─────────────────

test('Solis tadalafil 2.5 mg is "PA required (verify indication)"; only the "(pah)" row names PAH', () => {
  const { solisFormularyLookup } = require('./solisFormulary');
  const plain = solisFormularyLookup('tadalafil', 'H0982-007', 2027);
  assert.equal(plain.pa, true);
  assert.equal(plain.indication, undefined);
  assert.equal(D.edLabel({ ...plain }), 'Covered · PA required (verify indication)');
  const pah = solisFormularyLookup('tadalafil tab 20 mg (pah)', 'H0982-007', 2027);
  assert.equal(pah.indication, 'PAH');
});

test('Solis cost-share comes from the 2027 KB; a tier with no cost says "cost n/a", never a bare tier', () => {
  assert.equal(F.costShareFromKnowledge('H0982-007', 2027, 3).value, '$15');
  assert.equal(F.costShareFromKnowledge('H0982-007', 2027, 4).value, '40%');
  const plans = [{ planId: 'H0982-007', name: 'Solis Healthy Living' }];
  // A real Solis answer: the book prints every row's requirements, so PA/ST/QL are explicit false.
  const pdfRow = { verified: true, tier: 2, coverage: 'covered', costShare: null, pa: false, st: false, ql: false, source: 'Solis 2027 Comprehensive Formulary PDF (updated 10/05/2026)' };
  assert.equal(N.medsTable([{ drugName: 'x', byPlanId: { 'H0982-007': pdfRow }, lookups: [pdfRow] }], plans).split('\n')[2], '| x | T2 · cost n/a (PDF) |');
  const apiRow = { verified: true, tier: 2, coverage: 'covered', costShare: null, pa: null, st: null, ql: null, source: 'medicare_gov' };
  assert.equal(N.medsTable([{ drugName: 'x', byPlanId: { 'H0982-007': apiRow }, lookups: [apiRow] }], plans).split('\n')[2], '| x | T2 · cost n/a · PA/QL ? |');
});

test('FORMULARY_DEBUG=1 logs one line per drug per plan; off by default', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { const s = a.join(' '); if (s.startsWith('[formulary-debug]')) lines.push(s); };
  try {
    delete process.env.FORMULARY_DEBUG;
    await priceAll(['rasuvostatin'], ['H1019-001']);
    assert.equal(lines.length, 0);
    process.env.FORMULARY_DEBUG = '1';
    await priceAll(['rasuvostatin', 'acyclovir ointment'], ['H1019-001', 'H5431-006']);
  } finally {
    console.log = orig;
    delete process.env.FORMULARY_DEBUG;
  }
  assert.equal(lines.length, 4, lines.join('\n'));
  assert.match(lines[0], /^\[formulary-debug\] H1019-001 \| rasuvostatin → rosuvastatin \(\d+\) \| source=medicare_gov \| status=verified_covered \| result=T1 · cost \$0 · PA\/QL \?$/);
  assert.match(lines[2], /^\[formulary-debug\] H1019-001 \| acyclovir ointment → acyclovir topical ointment \(\d+\) \| source=medicare_gov \| status=verified_not_covered \| result=not covered$/);
});

// ─── strength split (2026-10-09 review: Solis tadalafil T4/PA at 2.5–5 mg, T6 "^" at 10–20 mg) ──

test('Solis "^" is a supplemental (excluded) drug; a typed strength uses only that row', () => {
  const { solisFormularyLookup } = require('./solisFormulary');
  const ten = solisFormularyLookup('tadalafil 10 mg', 'H0982-007', 2027);
  assert.equal(ten.tier, 6);
  assert.equal(ten.excludedDrug, true);
  assert.equal(ten.qlText, 'QL 8/30');
  assert.equal(D.edLabel(ten), D.ED_LABELS.supplemental);
  assert.equal(solisFormularyLookup('tadalafil 5 mg', 'H0982-007', 2027).tier, 4);
});

test('tadalafil with no strength: every strength shown, compact, on Solis and medicare.gov plans', async () => {
  const [r] = await priceAll(['tadalafil'], ['H1019-001', 'H0982-007']);
  const plans = [{ planId: 'H1019-001', name: 'CarePlus CareOne Plus' }, { planId: 'H0982-007', name: 'Solis Healthy Living' }];
  const cells = N.medsTable([r], plans).split('\n')[2].split(' | ');
  // Per strength group: medicare.gov groups are "PA/QL ?", the not-covered group needs no marker,
  // and Solis groups carry the book's own PA/QL (no marker).
  assert.equal(cells[1], '2.5/10/20 mg: ❌ not covered ‖ 5 mg: T4 50% · PA/QL ? ‖ 20 mg (PAH): T4 50% · PA/QL ?');
  assert.doesNotMatch(cells[2], /PA\/QL \?/);
  assert.equal(cells[2], '2.5/5 mg: T4 40% · PA (verify indication) · QL 30/30 ‖ 10/20 mg: T6 $0 · QL 8/30 · supplemental ‖ 20 mg (PAH): T4 40% · PA · QL 60/30 |');
  const text = N.renderedAnswer(docs, `ZIP 33324. Meds: tadalafil. Compare H1019-001, H0982-007.`, { drugs: [r] });
  assert.match(text, /⚠️ tadalafil cost varies by strength — confirm dose/);
});

test('tadalafil with a strength: only that strength, no split', async () => {
  const [r10] = await priceAll(['tadalafil 10 mg'], ['H0982-007']);
  const row = r10.byPlanId['H0982-007'];
  assert.equal(row.strengths, undefined);
  assert.equal(row.tier, 6);
  assert.equal(row.edLabel, D.ED_LABELS.supplemental);
  const [r5] = await priceAll(['tadalafil 5 mg'], ['H1019-001']);
  assert.equal(r5.byPlanId['H1019-001'].strengths, undefined);
  assert.equal(r5.byPlanId['H1019-001'].tier, 4);
});

test('all strengths alike: one cell as before (trazodone on H1019-001)', async () => {
  const [r] = await priceAll(['trazodone'], ['H1019-001']);
  assert.equal(r.byPlanId['H1019-001'].strengths, undefined);
  assert.equal(N.medsTable([r], [{ planId: 'H1019-001', name: 'CarePlus' }]).split('\n')[2], '| trazodone | T1 $0 · PA/QL ? |');
});

// ─── restriction status: never a silent cell (2026-10-09 review) ─────────────────

test('medicare.gov cell shows "PA/QL ?"; the legend explains it only when a cell uses it', () => {
  const plans = [{ planId: 'H1019-001', name: 'CarePlus' }];
  const row = { verified: true, coverage: 'covered', tier: 4, costShare: '50%', pa: null, st: null, ql: null, source: 'medicare_gov', restrictionsKnown: false };
  const table = N.medsTable([{ drugName: 'tadalafil 5 mg', byPlanId: { 'H1019-001': row }, lookups: [row] }], plans);
  assert.equal(table.split('\n')[2], '| tadalafil 5 mg | T4 50% · PA/QL ? |');
  assert.match(N.medsLegendFor(table), / · PA\/QL \? = source doesn't report prior auth \/ quantity limits, verify in carrier formulary$/);
  const solis = { verified: true, coverage: 'covered', tier: 1, costShare: '$0', pa: false, st: false, ql: false, source: 'Solis 2027 Comprehensive Formulary PDF' };
  const clean = N.medsTable([{ drugName: 'trazodone', byPlanId: { 'H1019-001': solis }, lookups: [solis] }], plans);
  assert.equal(N.medsLegendFor(clean), R.MEDS_LEGEND, 'no "PA/QL ?" legend line when no cell uses it');
});

test('Solis cell with PA shows its flags and no marker; Solis cell with no PA/QL shows nothing extra', () => {
  const { solisFormularyLookup } = require('./solisFormulary');
  const plans = [{ planId: 'H0982-007', name: 'Solis Healthy Living' }];
  const withPa = { ...solisFormularyLookup('tadalafil 5 mg', 'H0982-007', 2027), costShare: '40%' };
  assert.equal(N.medsTable([{ drugName: 'sildenafil', byPlanId: { 'H0982-007': withPa }, lookups: [withPa] }], plans).split('\n')[2], '| sildenafil | T4 40% · PA · QL 30/30 |');
  const none = { ...solisFormularyLookup('trazodone 50 mg', 'H0982-007', 2027), costShare: '$0' };
  assert.equal(none.pa, false);
  assert.equal(N.medsTable([{ drugName: 'trazodone 50 mg', byPlanId: { 'H0982-007': none }, lookups: [none] }], plans).split('\n')[2], '| trazodone 50 mg | T1 $0 |');
});

test('Sunfire / FHIR answer that omits the restriction fields is unknown, never "none"', () => {
  assert.equal(D.restrictionsKnownFor({ source: 'sunfire:catalog', pa: null, st: null, ql: null }), false);
  assert.equal(D.restrictionsKnownFor({ source: 'humana_fhir', pa: false, st: null, ql: null }), true);
  assert.equal(D.restrictionsKnownFor({ source: 'medicare_gov', pa: true }), false);
  assert.equal(D.restrictionsUnknown({ verified: true, coverage: 'not_covered', source: 'medicare_gov' }), false, 'a not-covered cell needs no marker');
  const sunfire = { verified: true, coverage: 'covered', tier: 3, costShare: '$47', pa: null, st: null, ql: null, source: 'sunfire:catalog' };
  assert.equal(N.medsTable([{ drugName: 'Eliquis', byPlanId: { 'H1019-001': sunfire }, lookups: [sunfire] }], [{ planId: 'H1019-001', name: 'CarePlus' }]).split('\n')[2], '| Eliquis | T3 $47 · PA/QL ? |');
});

test('export (Excel/PDF) cells carry the same marker, synced into the UI page', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'comparison-export.js'), 'utf8');
  assert.match(src, /restrictionsUnknown\(status\) \? " · PA\/QL \?" : ""/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /restrictionsUnknown\(status\) \? " · PA\/QL \?" : ""/);
});

test('ranking uses the lowest-cost strength for a split drug', () => {
  const split = { drugName: 'tadalafil', lookups: [{ verified: true }],
    byPlanId: { 'H1019-001': { planId: 'H1019-001', verified: true, coverage: 'covered', tier: 4, costShare: '$40',
      strengths: [{ strength: '5 mg', coverage: 'covered', tier: 4, costShare: '$40' }, { strength: '10 mg', coverage: 'covered', tier: 6, costShare: '$0' }] } } };
  const sel = N.selectComparison(docs, ASK_TEXT, { drugs: [split] });
  const col = sel.columns.find((c) => c.planId === 'H1019-001');
  assert.equal(col.drugCost, 0);
});

// ─── staging run fixes (2026-10-09) ─────────────────────────────────────────────

test('typed "tadalafil 20 mg" is never priced on the PAH product (NDC 13668-0581-30)', async () => {
  const log = [];
  const [r] = await priceAll(['tadalafil 20 mg'], ['H1019-001'], log);
  const row = r.byPlanId['H1019-001'];
  assert.ok(!log.includes('13668058130'), 'the Pulmonary Hypertension product must not be priced');
  assert.notEqual(row.tier, 4);
  assert.equal(row.coverage, 'not_covered');
  assert.equal(row.edLabel, 'Not covered by this plan');
  // Asking for PAH still reaches it.
  const [pah] = await priceAll(['tadalafil 20 mg pah'], ['H1019-001'], []);
  assert.equal(pah.byPlanId['H1019-001'].tier, 4);
});

test('products at the same strength that disagree read "varies by product", not covered', async () => {
  const [r] = await priceAll(['testamol 10 mg'], ['H1019-001']);
  const row = r.byPlanId['H1019-001'];
  assert.equal(row.mixedProducts, true);
  assert.match(N.medsTable([r], [{ planId: 'H1019-001', name: 'CarePlus' }]).split('\n')[2], /^\| testamol .*\| T2 .*· varies by product · PA\/QL \? \|$/);
});

test('a PAH ask prices only the PAH product (no "varies by product" against the ED product)', async () => {
  const log = [];
  const [r] = await priceAll(['tadalafil 20 mg pah'], ['H1019-001'], log);
  assert.equal(r.nameCheck, undefined, '"pah" is not part of the drug name RxNorm checks');
  assert.equal(r.byPlanId['H1019-001'].tier, 4);
  assert.equal(r.byPlanId['H1019-001'].mixedProducts, undefined);
  assert.ok(!log.includes('13668056830'), 'the plain 20 mg product is not priced for a PAH ask');
});

test('ED-label cells print the source\'s PA/ST/QL flags (Solis tadalafil 10/20 mg: QL 8/30)', async () => {
  const plans = [{ planId: 'H0982-007', name: 'Solis Healthy Living' }];
  // Typed strength: one ED-label cell with the book's QL.
  const [r20] = await priceAll(['tadalafil 20 mg'], ['H0982-007']);
  assert.equal(N.medsTable([r20], plans).split('\n')[2].split(' | ')[1],
    'Covered — supplemental benefit (excluded drug; not counted toward Part D OOP max) · T6 $0 · QL 8/30 |');
  // No strength: the split cell shows the same group as "T6 $0 · QL 8/30 · supplemental".
  const [r] = await priceAll(['tadalafil'], ['H0982-007']);
  assert.match(N.medsTable([r], plans), /10\/20 mg: T6 \$0 · QL 8\/30 · supplemental/);
  // PA from the book on an ED cell (5 mg): "PA · QL 30/30", never dropped.
  const [r5] = await priceAll(['tadalafil 5 mg'], ['H0982-007']);
  assert.match(N.medsTable([r5], plans), /Covered · PA required \(verify indication\) · T4 40% · PA · QL 30\/30 \|/);
});

test('the typed strength stays in the row name ("Tadalafil 20 mg", "Rosuvastatin Calcium 10 mg")', async () => {
  const [t20, r10] = await priceAll(['tadalafil 20 mg', 'rosuvastatin 10 mg'], ['H1019-001']);
  assert.equal(t20.drugName, 'tadalafil 20 mg');
  assert.equal(r10.drugName, 'rosuvastatin 10 mg');
  // With a Sunfire catalog name the strength is added, never doubled.
  const row = { verified: true, coverage: 'covered', tier: 1, costShare: '$0', source: 'medicare_gov' };
  const plans = [{ planId: 'H1019-001', name: 'CarePlus' }];
  assert.match(N.medsTable([{ drugName: 'Rosuvastatin Calcium 10 mg', byPlanId: { 'H1019-001': row }, lookups: [row] }], plans), /\| Rosuvastatin Calcium 10 mg \|/);
  // The Spanish-style ask keeps both typed strengths through to the table.
  const msgs = [{ role: 'user', content: 'Martin Wiesenthal, 33324, Dr.Steven Barilla, Dr. Matthew Soff, Dra. Zuhdiyah Darojat, medicamentos esomeprazole, rosuvastatin 10 mg, tadalafil 20 mg, trazodone, acyclovir ointment' }];
  assert.deepEqual(R.medsFromAsk(N.comparisonAskText(msgs, conversationAskText(msgs))), ['esomeprazole', 'rosuvastatin 10 mg', 'tadalafil 20 mg', 'trazodone', 'acyclovir ointment']);
  const table = N.medsTable([t20, r10], plans);
  assert.match(table, /\| tadalafil 20 mg \|/);
  assert.match(table, /\| rosuvastatin 10 mg \|/);
});
