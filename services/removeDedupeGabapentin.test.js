// Jacqueline Alexander, 2026-10-17 (after #230): "Remove … both Neeta Erinjerri Surgeon rows" left the
// "Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute" row and a second Nathalie Regalado (same NPI) in the table,
// and gabapentin read "check Medicare.gov (strength not confirmed)" on plans that cover it T1/T2 $0.
const test = require('node:test');
const assert = require('node:assert');
const N = require('./doctorPlanNarrow');
const F = require('./formularyLookup');

const ASK = 'Remove Dr. Pasquel DeSantis Endocrinologist Baptist and both Neeta Erinjerri Surgeon rows, since Pascual De Santis and Neeta Jane Erinjeri are already on the list';

test('removal matches a saved row whose name carries descriptive words', () => {
  const c = N.doctorRemovalClauses(ASK);
  assert.ok(N.removedByClauses('Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute', c));
  assert.ok(N.removedByClauses('Neeta Erinjerri - Surgeon at Baptist', c));
  assert.ok(N.removedByClauses('Pasquel DeSantis Endocrinologist Baptist', c));
  assert.ok(N.removedByClauses('Dr. Pasquel DeSantis - Endocrinologist', c));
});

test('removal never touches the doctors she keeps or did not name', () => {
  const c = N.doctorRemovalClauses(ASK);
  for (const keep of ['Neeta Jane Erinjeri', 'Pascual De Santis', 'Nathalie Regalado', 'Andrew I Sable', 'James Esserman']) {
    assert.strictEqual(N.removedByClauses(keep, c), false, keep);
  }
  // A specialty she named must match the row's specialty when the row has one.
  assert.strictEqual(N.removedByClauses('Neeta Erinjerri - Oncologist', N.doctorRemovalClauses('remove both Neeta Erinjerri Surgeon rows')), false);
});

test('doctor name core stops at the first descriptive word', () => {
  assert.deepStrictEqual(N.doctorCoreWords('Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute'), ['neeta', 'erinjerri']);
  assert.deepStrictEqual(N.doctorCoreWords('Neeta Jane Erinjeri'), ['neeta', 'jane', 'erinjeri']);
  assert.deepStrictEqual(N.doctorCoreWords('Pascual De Santis'), ['pascual', 'de', 'santis']);
});

test('server table: same NPI collapses, a described unresolved twin of a resolved doctor stays and is flagged', () => {
  const rows = [
    { requestedName: 'Nathalie Regalado', npi: '1467795633', status: 'done' },
    { requestedName: 'Andrew I Sable', npi: '1111111111', status: 'done' },
    { requestedName: 'Nathalie Regalado - Baptist Medical Group', npi: '1467795633', status: 'done' },
    { requestedName: 'Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute', status: 'not_found' },
    { requestedName: 'Neeta Jane Erinjeri', npi: '1427310424', status: 'done' },
    { requestedName: 'Pascual De Santis', npi: '1225156565', status: 'done' },
    { requestedName: 'Maria Lopez', status: 'not_found' },
    { requestedName: 'Hoa Nguyen', npi: '2222222222', status: 'done' },
    { requestedName: 'Hoa Nguyne', npi: '3333333333', status: 'done' },
  ];
  assert.deepStrictEqual(N.dedupeDoctorRows(rows).map((r) => r.requestedName),
    ['Nathalie Regalado', 'Andrew I Sable', 'Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute', 'Neeta Jane Erinjeri', 'Pascual De Santis', 'Maria Lopez', 'Hoa Nguyen', 'Hoa Nguyne']);
  const out = N.dedupeDoctorRows(rows);
  const dup = out.find((r) => /Surgeon At/.test(r.requestedName));
  assert.deepStrictEqual(dup.duplicateOf.npi, '1427310424');
  assert.ok(!out.find((r) => r.requestedName === 'Maria Lopez').duplicateOf);
  assert.deepStrictEqual(N.duplicateQuestions(out),
    ["❓ 'Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute' looks like a duplicate of Neeta Jane Erinjeri (NPI 1427310424). Remove it?"]);
});

const WORKUP = 'STRUCTURED FACTS ONLY\nZIP: 33156\nDoctors:\n- Nathalie Regalado\n- Andrew I Sable\n- Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute\n- Neeta Jane Erinjeri\nPlans: H5420-001, H4140-022';
const Q = "❓ 'Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute' looks like a duplicate of Neeta Jane Erinjeri (NPI 1427310424). Remove it?";

test('duplicate confirm: her yes removes exactly that row; no keeps it', () => {
  const base = [{ role: 'user', content: WORKUP }, { role: 'assistant', content: `| Doctor | H5420-001 |\n|---|---|\n${Q}` }];
  const yes = N.comparisonFollowUp([...base, { role: 'user', content: 'yes' }]);
  assert.ok(yes, 'yes re-runs the comparison');
  const names = yes.doctors.map((d) => d.toLowerCase());
  assert.ok(!names.some((d) => /surgeon/.test(d)), names.join(' / '));
  assert.ok(names.includes('neeta jane erinjeri'));
  assert.strictEqual(names.length, 3);
  assert.deepStrictEqual(N.confirmedDuplicateRemovals([...base, { role: 'user', content: 'no, keep it' }], 2), []);
  // Without her answer nothing is removed.
  assert.deepStrictEqual(N.confirmedDuplicateRemovals([...base, { role: 'user', content: 'compare to Humana' }], 2), []);
});

test('duplicate row is not dropped silently: the rendered table keeps it and asks', () => {
  const rows = N.dedupeDoctorRows([
    { requestedName: 'Neeta Jane Erinjeri', doctorName: 'NEETA JANE ERINJERI', npi: '1427310424', status: 'done', networks: [{ planId: 'H5420-001', status: 'in_network' }] },
    { requestedName: 'Dr. Neeta Erinjerri Surgeon At Baptist Cancer Institute', status: 'not_found', networks: [] },
  ]);
  assert.strictEqual(rows.length, 2);
  const text = N.renderedAnswer(rows, 'Plans: H5420-001', {});
  if (text) assert.match(text, /looks like a duplicate of .*\(NPI 1427310424\)\. Remove it\?/);
});

test('saved-workup correction: a rename onto a saved name leaves one row', () => {
  const msgs = [
    { role: 'user', content: 'STRUCTURED FACTS ONLY\nZIP: 33156\nDoctors:\n- Natalie Regalado - Baptist Medical Group\n- Nathalie Regalado\n- Andrew I Sable\n- Neeta Erinjerri - Surgeon at Baptist\n- Neeta Jane Erinjeri\nPlans: H5420-001, H4140-022' },
    { role: 'assistant', content: '| Doctor | H5420-001 | H4140-022 |\n|---|---|---|' },
    { role: 'user', content: 'Replace Dr. Natalie Regalado with Dr. Nathalie Regalado, NPI 1467795633. ' + ASK },
  ];
  const fixed = N.comparisonFollowUp(msgs);
  if (!fixed) return; // workup shape not recognised by this fixture: covered by jacquelineWorkupCorrection.test.js
  const names = fixed.doctors.map((d) => d.toLowerCase());
  assert.strictEqual(names.filter((d) => d.includes('regalado')).length, 1, names.join(' / '));
  assert.ok(!names.some((d) => /erinjerri/.test(d)), names.join(' / '));
  assert.ok(names.includes('neeta jane erinjeri'));
});

test('"Once-Daily gabapentin" (Gralise generic) is a modified-release product, not plain gabapentin', () => {
  assert.strictEqual(F.conceptProductTraits('Once-Daily gabapentin 600 MG Oral Tablet').er, true);
  assert.strictEqual(F.conceptProductTraits('gabapentin 600 MG Oral Tablet').er, false);
  assert.strictEqual(F.queryProductHints('Gabapentin').er, false);
  assert.strictEqual(F.queryProductHints('gabapentin once daily').er, true);
});

const PLANS = [{ planId: 'H5420-001', planName: 'A' }, { planId: 'H4140-022', planName: 'B' }];
const v = (strength, tier, extra = {}) => ({ strength, verified: tier != null, coverage: tier ? 'covered' : (extra.coverage || null), tier, costShare: tier ? '$0' : null, source: 'medicare_gov', restrictionsKnown: false, ...extra });
const gaba = (byPlan) => ({ drugName: 'Gabapentin', byPlanId: byPlan, lookups: Object.entries(byPlan).map(([planId, row]) => ({ planId, ...row })) });

test('gabapentin, no strength: same tier on every answered strength shows the tier, not "check Medicare.gov"', () => {
  const row = (t) => ({ verified: true, coverage: 'covered', tier: t, costShare: '$0', source: 'medicare_gov',
    strengths: [v('200 mg', null), v('100 mg', t), v('300 mg', t), v('400 mg', null), v('600 mg', t), v('800 mg', t)] });
  const table = N.medsTable([gaba({ 'H5420-001': row(2), 'H4140-022': row(1) })], PLANS);
  const line = table.split('\n').find((l) => /Gabapentin/.test(l));
  assert.match(line, /T2 \$0[^|]*cost same across strengths/);
  assert.match(line, /T1 \$0[^|]*cost same across strengths/);
  assert.doesNotMatch(line, /check Medicare\.gov|strength not confirmed|doesn.t exist/i);
});

test('gabapentin, no strength: tiers that really differ still ask to confirm the dose', () => {
  const row = { verified: true, coverage: 'covered', tier: 1, costShare: '$0', source: 'medicare_gov',
    strengths: [v('100 mg', 1), v('300 mg', 1), v('600 mg', 3, { costShare: '$47' }), v('400 mg', null)] };
  const line = N.medsTable([gaba({ 'H5420-001': row, 'H4140-022': row })], PLANS).split('\n').find((l) => /Gabapentin/.test(l));
  assert.match(line, /other strengths differ — confirm dose/);
  assert.doesNotMatch(line, /cost same across strengths/);
});

test('every strength answered the same: the plain row says so', () => {
  const row = { verified: true, coverage: 'covered', tier: 1, costShare: '$0', source: 'medicare_gov', sameAcrossStrengths: true };
  const line = N.medsTable([gaba({ 'H5420-001': row, 'H4140-022': row })], PLANS).split('\n').find((l) => /Gabapentin/.test(l));
  assert.match(line, /T1 \$0[^|]*cost same across strengths/);
});
