// Maura Soley live chat, 2026-10-07 4:30–4:38 PM ET (ZIP 33018, Miami-Dade, current plan UHC H1045-001).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const { guestPlanIdsFor } = require('./providerNetwork');
const E = require('../artifacts/comparison-export.js');

const CTX = 'LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript).\nClient: Maura Soley\nZIP/county: 33018 / Miami-Dade\nCurrent plan: H1045-001\nPlans:\n- UHC Preferred Care Preferred MA (H1045-001)\n- Aetna Medicare Select Care (H1609-093)\nDoctors (names only — pass exactly these names to lookup_provider_network): Dr. Cheryl Case-Diaz; Dr. Barbara Martinez; Dr. Nathan Hirsch; Dr. Cynthia Golomb; Dr. Allister G Gibbons Fell';
const thread = (ask) => [{ role: 'user', content: CTX }, { role: 'assistant', content: 'Miami-Dade diabetes/heart C-SNPs: UHC H1045-018, H5420-014; CarePlus H1019-121, H1019-150; Devoted H1290-067, H1290-085; HealthSun H5431-021; Solis H0982-016, H0982-028.' }, { role: 'user', content: ask }];
const NAMES = {
  'H1045-001': 'UHC Preferred Care Preferred MA', 'H1045-018': 'UHC Preferred Complete Care FL-0003', 'H5420-014': 'UHC MedicareMax Complete Care FL-30',
  'H1290-067': 'Devoted C-SNP ENHANCED', 'H1290-085': 'Devoted C-SNP PLUS', 'H1609-093': 'Aetna Medicare Select Care', 'H1609-094': 'Aetna Medicare Chronic Care',
  'H1609-018': 'Aetna Medicare Select',
};
const L = (id) => `${NAMES[id]} (${id})`;
function doc(name, npi, ins, ids) {
  return { requestedName: name, doctorName: name, npi, status: 'done', pending: [], failed: [], networks: [], carriersIn: [],
    inNetworkPlans: ins.map(L), outOfNetworkPlans: ids.filter((x) => !ins.includes(x)).map(L) };
}
function countsMatchCells(table) {
  const rows = table.split('\n').filter((l) => l.startsWith('|') && !/^\|---/.test(l));
  const body = rows.slice(1, -1).map((r) => r.split('|').slice(2, -1).map((c) => c.trim()));
  const totals = rows[rows.length - 1].split('|').slice(2, -1).map((c) => c.trim());
  totals.forEach((t, k) => {
    const col = body.map((r) => r[k]);
    const m = t.match(/(\d+) in · (\d+) not in network/);
    assert.ok(m, t);
    assert.equal(Number(m[1]), col.filter((c) => c === '✅ In').length, `in count, column ${k}`);
    assert.equal(Number(m[2]), col.filter((c) => c === R.NOT_LISTED_CELL).length, `not-in-network count, column ${k}`);
  });
}

test('"run her drs on the csnps with cardiovascular disorders" is agent-confirmed, never refused', () => {
  const ask = 'yeah run her drs on the csnps with cardiovascular disorders';
  const e = R.eligibilityFromAsk(ask);
  assert.equal(e.csnp, 'confirmed');
  assert.deepEqual(e.conditions, ['heart']);
  assert.ok(R.csnpRunAsk(ask));
  assert.ok(!R.csnpRunAsk('is she eligible for a c-snp?'));
  assert.ok(!R.csnpRunAsk('no csnps'));
  // Heart C-SNPs on the 2027 Miami-Dade grid stay; a lung / kidney-only C-SNP is not for her condition.
  const grid = R.gridPlansForCounty('Miami-Dade');
  const st = (id) => R.planEligibility(grid.find((g) => g.planId === id), e).status;
  for (const id of ['H1045-018', 'H5420-014', 'H1290-067', 'H1290-085', 'H1019-121', 'H5431-021', 'H0982-016']) assert.equal(st(id), 'eligible', id);
  assert.equal(st('H1036-297'), 'excluded'); // Humana Gold Plus Lung
  assert.ok(/AGENT-REQUESTED SNPs/.test(R.COMPARISON_TABLE_RULES) || /AGENT-REQUESTED SNPs/.test(fs.readFileSync(path.join(__dirname, 'comparisonRules.js'), 'utf8')));
  assert.match(fs.readFileSync(path.join(__dirname, 'comparisonRules.js'), 'utf8'), /THE GRID IS THE SOURCE OF TRUTH/);
});

test('C-SNP run: server runs her saved doctors on plan-level C-SNP columns, current plan first', () => {
  const msgs = thread('yeah run her drs on the csnps with cardiovascular disorders');
  const fu = N.comparisonFollowUp(msgs);
  assert.ok(fu && fu.doctors.length === 5, JSON.stringify(fu));
  assert.equal(fu.zip, '33018');
  const ask = N.comparisonAskText(msgs);
  assert.match(ask, /^Rank all eligible plans\.$/m);
  assert.match(ask, /^Run C-SNPs for heart/m);
  // Every county plan is checked plan-level (no single tool planId narrows UHC / Humana).
  assert.deepEqual(guestPlanIdsFor(['H1045-001'], ask), []);
  const ids = Object.keys(NAMES).filter((id) => !/H1609/.test(id));
  const docs = [
    doc('Cheryl Case-Diaz', '1184615874', ['H1045-001', 'H1045-018', 'H1290-067'], ids),
    doc('Barbara Martinez', '1649435041', ['H1045-001', 'H5420-014', 'H1045-018'], ids),
    doc('Nathan Hirsch', '1720196454', ['H1290-067'], ids),
    doc('Cynthia Golomb', '1619900388', ['H1290-085'], ids),
    doc('Allister G Gibbons Fell', '1548524465', ['H5420-014'], ids),
  ];
  const sel = N.selectComparison(docs, ask, {});
  const cols = sel.columns.map((c) => c.planId);
  assert.equal(cols[0], 'H1045-001');
  assert.ok(cols.length >= 4, cols.join());
  for (const id of cols.slice(1)) assert.equal(R.snpKind(R.gridPlansForCounty('Miami-Dade').find((g) => g.planId === id)), 'csnp', id);
  const text = N.renderedAnswer(docs, ask, {});
  assert.doesNotMatch(text, /In\*/); // plan-level cells, not carrier-level
  assert.doesNotMatch(text, /no qualifying condition|unverified/i);
  assert.match(text, /H1045-018 = same doctor results as H1045-001/);
  countsMatchCells(text.split('\n').filter((l) => l.startsWith('|')).join('\n'));
});

test('"show me aetna csnp, aetna core, and her current plan on a grid": exactly those 3 columns', () => {
  const msgs = thread('show me aetna csnp, aetna core, and her current plan on a grid');
  const ask = N.comparisonAskText(msgs);
  assert.match(ask, /^Named plan set: .*H1609-094.*H1609-093.*H1045-001/m);
  const ids = ['H1045-001', 'H1609-093', 'H1609-094', 'H1609-018'];
  const docs = [
    { ...doc('Cheryl Case-Diaz', '1184615874', ['H1045-001', 'H1609-093', 'H1609-018'], ids), carriersIn: ['Aetna', 'UnitedHealthcare'] },
    { ...doc('Allister G Gibbons Fell', '1548524465', ['H1609-094', 'H1609-093', 'H1609-018'], ids), carriersIn: ['Aetna'] },
  ];
  const sel = N.selectComparison(docs, ask, {});
  assert.deepEqual(sel.columns.map((c) => c.planId).sort(), ['H1045-001', 'H1609-093', 'H1609-094']);
  const text = N.renderedAnswer(docs, ask, {});
  assert.doesNotMatch(text, /H1609-018/); // Broward-only, never asked for
  assert.doesNotMatch(text, /no qualifying condition/i);
  assert.equal((text.match(/confirmed at enrollment/g) || []).length, 1);
  countsMatchCells(text.split('\n').filter((l) => l.startsWith('|')).join('\n'));
});

test('county guard: an out-of-county grid plan is never added; one she names gets a one-line warning', () => {
  const ids = ['H1045-001', 'H1609-093', 'H1609-018'];
  const docs = [doc('Cheryl Case-Diaz', '1184615874', ids, ids), doc('Nathan Hirsch', '1720196454', ['H1609-018'], ids)];
  const ranked = N.selectComparison(docs, 'ZIP 33018.\nHer current plan: H1045-001.\nRank all eligible plans.', {});
  assert.ok(!ranked.columns.some((c) => c.planId === 'H1609-018'));
  const named = N.selectComparison(docs, 'ZIP 33018. Compare UHC Preferred Care Preferred MA H1045-001, Aetna Medicare Select Care H1609-093 and Aetna Medicare Select H1609-018', {});
  assert.ok(named.columns.some((c) => c.planId === 'H1609-018'));
  assert.ok(named.flags.some((f) => f === '⚠️ Not offered in Miami-Dade: H1609-018 (Broward grid).'), named.flags.join('\n'));
});

test('export chips follow any reply with a doctor / med table, even with a question in it', () => {
  const reply = '| Doctor | Aetna Medicare Chronic Care · H1609-094 |\n|---|---|\n| Hirsch | ✅ In |\n\nIs she on Medicaid or an MSP?';
  assert.ok(E.hasComparisonTable(reply));
  assert.equal(E.isNarrowingReply(reply), false);
  assert.equal(E.isNarrowingReply('Is she on Medicaid or an MSP? Once I have those answers I will narrow it down.'), true);
  const html = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /found\.length >= 2 \|\| \(found\.length >= 1 && tableReply\)/);
});

test('Show benefits: every column from the whole grid by contract-PBP, one side-by-side table', () => {
  const pool = R.gridPlansForCounty('');
  const rows = E.benefitPlansFor([{ planId: 'H1045-001' }, 'H1609-093', 'H1609-018'], pool, 'Miami-Dade');
  assert.deepEqual(rows.map((r) => r.planId), ['H1045-001', 'H1609-093', 'H1609-018']);
  assert.equal(rows[0].county, 'Miami-Dade');
  const t = E.benefitsTable(rows, 'Miami-Dade');
  const lines = t.split('\n').filter((l) => l.startsWith('|') && !/^\|---/.test(l));
  assert.match(lines[0], /H1045-001.*H1609-093.*H1609-018/);
  for (const l of lines) assert.equal(l.split('|').length - 2, 4, l); // Benefit + 3 plans on every row
  assert.match(t, /\| Premium \| \$0 \|/);
  assert.match(t, /⚠️ Not offered in Miami-Dade: H1609-018 \(Broward grid\)\./);
  const html = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /MaxComparisonExport\.benefitsTable\(rowsB, countyB\)/);
  assert.match(html, /attach every column of the last comparison/);
});
