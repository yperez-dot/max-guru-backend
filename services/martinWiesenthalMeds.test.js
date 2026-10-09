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

const EXACT = { esomeprazole: '283742', tadalafil: '358263', trazodone: '82112', acyclovir: '281', rosuvastatin: '301542' };
const CONCEPTS = {
  283742: [
    ['433733', 'esomeprazole 20 MG Delayed Release Oral Tablet'], // OTC (Nexium 24HR store brands)
    ['994005', 'esomeprazole 20 MG / naproxen 375 MG Delayed Release Oral Tablet'], // Vimovo
    ['606726', 'esomeprazole 20 MG Delayed Release Oral Capsule'], // the Rx product
  ],
  301542: [['859424', 'rosuvastatin calcium 10 MG Oral Tablet']],
  358263: [['402019', 'tadalafil 5 MG Oral Tablet']],
  82112: [['856364', 'trazodone hydrochloride 50 MG Oral Tablet']],
  281: [['197311', 'acyclovir 400 MG Oral Tablet'], ['197312', 'acyclovir 0.05 MG/MG Topical Ointment']],
  1544379: [['1544383', '0.2 ML methotrexate 50 MG/ML Auto-Injector [Rasuvo]']],
};
const NDCS = { 433733: ['00363036142'], 994005: ['76420089030'], 606726: ['00093645056'], 859424: ['00093744898'], 402019: ['13668058130'], 856364: ['00378347301'], 197311: ['00378025301'], 197312: ['00472008216'], 1544383: ['59137050504'] };
const OTC = new Set(['00363036142']);
// medicare.gov drug cost answers on H1019-001 2027 (live, 2026-10-09).
const COST = {
  '00093645056': { tier: 3, covered: true }, // esomeprazole DR capsule
  '76420089030': { covered: false, reason: 'NOT_COVERED' }, // Vimovo
  '00093744898': { tier: 1, covered: true },
  '13668058130': { tier: 4, covered: true },
  '00378347301': { tier: 1, covered: true },
  '00378025301': { tier: 1, covered: true },
  '00472008216': { covered: false, reason: 'NOT_COVERED' },
};

function stubFetch(log) {
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, opts = {}) => {
    const u = String(url);
    const q = (k) => decodeURIComponent((u.match(new RegExp(`[?&]${k}=([^&]+)`)) || [])[1] || '').replace(/\+/g, ' ');
    if (/\/drugs\/cost$/.test(u)) {
      const body = JSON.parse(opts.body);
      const ndc = body.prescriptions[0].ndc;
      log.push(ndc);
      const c = COST[ndc];
      const plan = body.plans[0];
      return json({ plans: [{ plan, costs: [{ drug_costs: c ? [{ ndc, tier: c.tier || null, covered: c.covered, coverage_reason: c.reason || 'COVERED' }] : [] }], restrictions: [], excluded_drugs: [] }] });
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
  assert.ok(medRows.some((l) => /^\| tadalafil \| Covered — verify if supplemental benefit · T4/i.test(l)), medRows.join('\n'));
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
  const pdfRow = { verified: true, tier: 2, coverage: 'covered', costShare: null, source: 'Solis 2027 Comprehensive Formulary PDF (updated 10/05/2026)' };
  assert.equal(N.medsTable([{ drugName: 'x', byPlanId: { 'H0982-007': pdfRow }, lookups: [pdfRow] }], plans).split('\n')[2], '| x | T2 · cost n/a (PDF) |');
  const apiRow = { ...pdfRow, source: 'medicare_gov' };
  assert.equal(N.medsTable([{ drugName: 'x', byPlanId: { 'H0982-007': apiRow }, lookups: [apiRow] }], plans).split('\n')[2], '| x | T2 · cost n/a |');
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
  assert.match(lines[0], /^\[formulary-debug\] H1019-001 \| rasuvostatin → rosuvastatin \(\d+\) \| source=medicare_gov \| status=verified_covered \| result=T1 · cost \$0$/);
  assert.match(lines[2], /^\[formulary-debug\] H1019-001 \| acyclovir ointment → acyclovir topical ointment \(\d+\) \| source=medicare_gov \| status=verified_not_covered \| result=not covered$/);
});
