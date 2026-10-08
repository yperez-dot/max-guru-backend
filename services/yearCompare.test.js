const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('../artifacts/comparison-export.js');
const yc = require('../artifacts/year-compare.js');

const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
function block(id) {
  const m = html.match(new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`));
  assert.ok(m, `${id} block missing`);
  return JSON.parse(m[1]);
}
const plans2027 = block('plan-data');
const plans2026 = block('plan-data-2026');
const cms = block('year-compare-cms');
const ctx = { plans2026, plans2027, cms };

function run(text) {
  return yc.runYearCompare({ text, plans2026, plans2027, cms });
}
function rowFor(model, label) {
  const row = model.rows.find((r) => r.label === label);
  assert.ok(row, `row ${label} missing`);
  return row;
}

describe('plan ID normalization', () => {
  it('maps grid spellings to CMS contract-plan keys', () => {
    assert.equal(yc.normalizePlanKey('H1036-054C'), 'H1036-054');
    assert.equal(yc.normalizePlanKey('H129-002'), 'H1290-002');
    assert.equal(yc.normalizePlanKey('H1045-012-000'), 'H1045-012');
    assert.equal(yc.normalizePlanKey('H5420-001/0028'), 'H5420-001');
    assert.equal(yc.normalizePlanKey('H4140-13'), 'H4140-013');
    assert.equal(yc.normalizePlanKey('H5471-064-0'), 'H5471-064');
    assert.deepEqual(yc.planIdsInText('compare H1036-054C and h5471-125 vs H1036-054C'), ['H1036-054', 'H5471-125']);
  });
});

describe('year compare intent', () => {
  const yes = [
    'compare 2026 vs 2027 for H1036-054C',
    '2027 vs 2026 H5471-125',
    'what changed for H1036-054C?',
    'year over year for H4140-013',
    'YoY on her plan',
    'changes from 2026 to 2027 for Humana Gold Plus H1036-054C',
    'what is changing next year on H5420-014',
    "what's different next year vs last year for H1036-054C",
  ];
  const no = [
    'compare H1036-054C and H5216-345',
    "what's different between H1036-054C and H5471-125?",
    'export to excel',
    'what is the 2027 MOOP for H1036-054C',
    'does H1036-054C cover hearing aids in 2026',
    'what changed?',
  ];
  yes.forEach((t) => it(`yes: ${t}`, () => assert.equal(yc.wantsYearCompare(t), true)));
  no.forEach((t) => it(`no: ${t}`, () => assert.equal(yc.wantsYearCompare(t), false)));
  it('bare "what changed?" counts right after a year compare', () => {
    assert.equal(yc.wantsYearCompare('what changed?', { hasPlanContext: true }), true);
  });
});

describe('value normalization', () => {
  const n = yc.normalizeValue;
  it('reads money, percent and decimals the way the grid stores them', () => {
    assert.deepEqual(n(6000.0, 'dental').tokens, ['$6,000']);
    assert.deepEqual(n('$6,000 preventive & comprehensive', 'dental').tokens, ['$6,000']);
    assert.deepEqual(n(0.33, 'tier5').tokens, ['33%']);
    assert.deepEqual(n('0.33', 'tier5').tokens, ['33%']);
    assert.deepEqual(n('33%', 'tier5').tokens, ['33%']);
    assert.deepEqual(n('75', 'erCopay').tokens, ['$75']);
    assert.equal(n('$110 x month', 'otc').period, 'mo');
    assert.equal(n('$30 x quarter', 'otc').period, 'qtr');
  });
  it('does not guess unclear 2026 cells', () => {
    assert.equal(n('*', 'dentalCrowns').kind, 'unclear');
    assert.equal(n('50', 'tier4').kind, 'unclear');
    assert.equal(n(2, 'partBGiveback').kind, 'unclear');
    assert.equal(n('2', 'partBGiveback').kind, 'unclear');
    assert.equal(n('$9.30', 'partBGiveback').kind, 'amount');
    assert.equal(n(0, 'dentalImplants').kind, 'none');
    assert.equal(n('N/A', 'tier6').kind, 'none');
    assert.equal(n('', 'otc').kind, 'blank');
  });
  it('marks Changed / Same / Review', () => {
    const c = (a, b, k) => yc.compareValues(a, b, k).change;
    assert.equal(c(0, '$0', 'pcpCopay'), 'Same');
    assert.equal(c('0.33', '33%', 'tier5'), 'Same');
    assert.equal(c('$75 x Ground\n20% x Air', '$75 ground · 20% air', 'ambulance'), 'Same');
    assert.equal(c('$0 / $75', 'Non-hospital $0 · Hospital $75', 'advancedImaging'), 'Same');
    assert.equal(c('$110 x month', '$110/mo Healthy Options', 'otc'), 'Same');
    assert.equal(c('$30 x quarter', '$30/mo', 'otc'), 'Changed');
    assert.equal(c('$2,900', '$3,400', 'moop'), 'Changed');
    assert.equal(c(50, '40%', 'tier4'), 'Changed');
    assert.equal(c(0, 'No', 'dentalImplants'), 'Same');
    assert.equal(c('Yes', 'No', 'referral'), 'Changed');
    assert.equal(c('*', 'Yes — included in $6,000 allowance', 'dentalCrowns'), 'Review');
    assert.equal(c('SilverSneakers', 'SilverSneakers + Nifty', 'fitness'), 'Review');
    assert.equal(c('$1,500', '$1,500 allowance · $0 copay', 'dental'), 'Review');
    assert.equal(c('', '$50', 'otc'), 'Review');
    assert.equal(c('', '', 'otc'), '');
  });
});

describe('CMS crosswalk pairing', () => {
  it('ships the CMS crosswalk + landscape inline and in data/', () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/year-compare-cms.json'), 'utf8'));
    assert.deepEqual(file, cms);
    assert.match(cms.sources.crosswalk, /2027 Part C&D Plan Crosswalk/);
    assert.ok(cms.crosswalk.length > 100);
    assert.ok(cms.landscape['2026']['H1036-054|Miami-Dade']);
    assert.ok(cms.landscape['2027']['H1036-054|Miami-Dade']);
  });

  it('same ID renewal: H1036-054C', () => {
    const { pairs } = yc.resolveYearPairs(['H1036-054'], ctx);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].kind, 'renewal');
    assert.equal(pairs[0].plan26.planId, 'H1036-054C');
    assert.equal(pairs[0].plan27.planId, 'H1036-054C');
  });

  it('renumbered: a 2026 ID follows the crosswalk to its 2027 plan (H5471-064 → H5471-125)', () => {
    const { pairs } = yc.resolveYearPairs(['H5471-064'], ctx);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].kind, 'renumbered');
    assert.equal(pairs[0].id26, 'H5471-064');
    assert.equal(pairs[0].id27, 'H5471-125');
    assert.equal(pairs[0].county, 'Miami-Dade');
    assert.ok(pairs[0].notes.some((x) => /^Renumbered: 2026 H5471-064 .* → 2027 H5471-125/.test(x)));
  });

  it('renumbered from the 2027 side picks the closest 2026 predecessor on file', () => {
    const { pairs } = yc.resolveYearPairs(['H4140-020'], ctx, { county: 'Broward' });
    assert.equal(pairs[0].kind, 'renumbered');
    assert.equal(pairs[0].id26, 'H4140-013');
    const aetna = yc.resolveYearPairs(['H1609-103'], ctx, { county: 'Broward' }).pairs[0];
    assert.equal(aetna.kind, 'renumbered');
    assert.equal(aetna.id26, 'H1609-043');
  });

  it('flags a same-ID plan whose product changed (H4140-013 DrFlex → DrFullDual-SFL)', () => {
    const { pairs } = yc.resolveYearPairs(['H4140-013'], ctx, { county: 'Miami-Dade' });
    assert.equal(pairs[0].kind, 'consolidated');
    assert.ok(pairs[0].flags.some((f) => /Same plan ID, different product: 2026 DrFlex → 2027 DrFullDual-SFL/.test(f)));
    assert.ok(pairs[0].notes.some((x) => /H4140-002/.test(x)));
    const plain = yc.resolveYearPairs(['H1036-054'], ctx).pairs[0];
    assert.deepEqual(plain.flags, []);
  });

  it('new for 2027 gets the note and no 2026 side', () => {
    const { pairs } = yc.resolveYearPairs(['H7617-145'], ctx, { county: 'Miami-Dade' });
    assert.equal(pairs[0].kind, 'new');
    assert.ok(pairs[0].notes.includes(yc.NEW_NOTE));
    assert.equal(pairs[0].plan26, null);
  });

  it('no 2026 county row: premium and MOOP from CMS only (H1526-004 Broward, H5471-125 Broward)', () => {
    for (const id of ['H1526-004', 'H5471-125']) {
      const { pairs } = yc.resolveYearPairs([id], ctx, { county: 'Broward' });
      assert.equal(pairs[0].kind, 'no2026row', id);
      const model = yc.buildYearCompareModel({ pairs, cms });
      const graded = model.rows.filter((r) => ['Changed', 'Same', 'Review'].includes(r.cells[0].change));
      assert.deepEqual(graded.map((r) => r.section), graded.map(() => 'cms'), id);
      assert.ok(graded.length >= 2, id);
      const otc = model.rows.find((r) => r.key === 'otc');
      if (otc) assert.equal(otc.cells[0].v26, 'Not on file');
    }
  });

  it('matches the Devoted "H129-002" 2026 typo row to 2027 H1290-002', () => {
    const { pairs } = yc.resolveYearPairs(['H1290-002'], ctx, { county: 'Broward' });
    assert.equal(pairs[0].kind, 'renewal');
    assert.equal(String(pairs[0].plan26.planId).replace(/\s/g, ''), 'H129-002');
  });

  it('a 2026 plan with no 2027 plan reports that it ends (HealthSpring H5410-056)', () => {
    const { pairs } = yc.resolveYearPairs(['H5410-056'], ctx, { county: 'Miami-Dade' });
    assert.equal(pairs[0].kind, 'ending');
    assert.match(pairs[0].notes[0], /Not offered in 2027 \(CMS: Terminated/);
  });

  it('unknown IDs come back unresolved', () => {
    const r = yc.resolveYearPairs(['H9999-999'], ctx);
    assert.deepEqual(r.pairs, []);
    assert.deepEqual(r.unresolved, ['H9999-999']);
  });
});

describe('H1036-054C example', () => {
  const r = run('Client: Maria Arias Lazo\ncompare 2026 vs 2027 for H1036-054C');
  const m = r.model;

  it('puts CMS premium / MOOP / Part D deductible / stars on top', () => {
    assert.deepEqual(m.rows.slice(0, 4).map((x) => x.key), ['premium', 'moop', 'partDDeductible', 'starRating']);
    assert.equal(rowFor(m, 'Monthly Premium (CMS, before Extra Help)').cells[0].change, 'Same');
    const moop = rowFor(m, 'Max Out of Pocket — in-network (CMS)').cells[0];
    assert.equal(moop.v26, '$500');
    assert.equal(moop.v27, '$500');
    assert.equal(moop.change, 'Same');
    const star = rowFor(m, 'Overall Star Rating (CMS)').cells[0];
    assert.equal(star.v26, '4.5');
    assert.equal(star.change, 'Pending');
    // Grid Premium / MOOP rows are not repeated under the CMS rows.
    assert.equal(m.rows.filter((x) => x.key === 'premium').length, 1);
    assert.equal(m.rows.filter((x) => x.key === 'moop').length, 1);
  });

  it('grades the benefit rows', () => {
    assert.equal(rowFor(m, 'Hearing Services').cells[0].change, 'Changed');
    assert.equal(rowFor(m, 'Tier 4').cells[0].change, 'Changed');
    assert.equal(rowFor(m, 'Vision Allowance').cells[0].change, 'Same');
    assert.equal(rowFor(m, 'OTC').cells[0].change, 'Same');
    assert.equal(rowFor(m, 'Tier 5').cells[0].change, 'Same');
    assert.equal(rowFor(m, 'Crowns').cells[0].change, 'Review');
    const giveback = rowFor(m, 'Part B Rebate').cells[0];
    assert.equal(giveback.change, 'Review');
    assert.match(giveback.v26, /^2 \(unclear/);
  });

  it('chat reply lists only changed rows, the unchanged count and both SOB links', () => {
    const t = r.chatText;
    assert.match(t, /\*\*2026 → 2027: Humana Gold Plus H1036-054C \(Miami-Dade\)\*\*/);
    assert.match(t, /- Hearing Services: \$1000 x 1 ear x 1 year → /);
    assert.match(t, /- Tier 4: \$50 → 40%/);
    assert.doesNotMatch(t, /- Vision Allowance/);
    assert.doesNotMatch(t, /- Part B Rebate/);
    assert.match(t, /Unchanged: \d+ rows/);
    assert.match(t, /\[2026 SoB\]\(https:\/\/www\.humana-medicare\.com\/BenefitSummary\/2026PDFs\/H1036054000SB26\.pdf\)/);
    assert.match(t, /\[2027 SoB\]\(https:\/\/assets\.humana\.com\//);
  });

  it('export model follows the client sheet rules', () => {
    assert.equal(m.title, 'Maria Arias Lazo');
    assert.equal(m.aoa[0][0], 'Maria Arias Lazo');
    assert.deepEqual(m.headers, ['', '2026\nHumana Gold Plus\nH1036-054C', '2027\nHumana Gold Plus\nH1036-054C', 'Change']);
    assert.equal(m.filenameXlsx, 'Maria_Arias_Lazo_2026_vs_2027_H1036-054C.xlsx');
    assert.equal(m.filenamePdf, 'Maria_Arias_Lazo_2026_vs_2027_H1036-054C.pdf');
    // Changed rows are highlighted; Same rows are not.
    const hearingRow = m.aoa.findIndex((row) => row[0] === 'Hearing Services');
    assert.equal(m.styles[hearingRow + ',3'].fill.fgColor.rgb, 'FCE4D6');
    const visionRow = m.aoa.findIndex((row) => row[0] === 'Vision Allowance');
    assert.equal(m.styles[visionRow + ',1'], undefined);
    // SOB links for both years.
    const urls = m.hyperlinks.map((h) => h.url);
    assert.ok(urls.some((u) => /SB26/.test(u)));
    assert.ok(urls.some((u) => /SB27/.test(u)));
  });
});

describe('multi-plan export', () => {
  const r = run('Client: Maria Arias Lazo\nwhat changed 2026 vs 2027 for H1036-054C, H5471-064 and H7617-145 in Miami-Dade');
  const m = r.model;

  it('one 2026 / 2027 / Change column group per plan', () => {
    assert.equal(r.pairs.length, 3);
    assert.equal(m.colCount, 10);
    assert.equal(m.headers.length, 10);
    assert.deepEqual([m.headers[3], m.headers[6], m.headers[9]], ['Change', 'Change', 'Change']);
    assert.match(m.headers[4], /^2026\nSimply Complete/);
    assert.match(m.headers[4], /H5471-064/);
    assert.match(m.headers[5], /^2027\nSimply Complete Platinum/);
    assert.equal(m.headers[7], '2026\nNo 2026 plan');
    assert.doesNotMatch(m.headers.join(' '), /NEW 2027|COMMISSIONABLE|\*\*/);
    assert.equal(m.filenameXlsx, 'Maria_Arias_Lazo_2026_vs_2027_H1036-054C_H5471-064_to_H5471-125_H7617-145.xlsx');
  });

  it('plan notes sit in one merged row under the headers', () => {
    const noteRow = m.aoa.findIndex((row) => row[0] === 'Plan note');
    assert.ok(noteRow > 0);
    assert.match(m.aoa[noteRow][4], /Renumbered: 2026 H5471-064/);
    assert.match(m.aoa[noteRow][7], /New for 2027 — no 2026 plan/);
    for (const c of [1, 4, 7]) {
      assert.ok(m.merges.some((x) => x.s.r === noteRow && x.s.c === c && x.e.c === c + 2));
    }
  });

  it('has no junk rows: every benefit row has a value somewhere', () => {
    m.rows.forEach((row) => {
      assert.ok(row.cells.some((c) => !c.blank), row.label);
    });
    const labels = m.aoa.map((row) => row[0]);
    assert.equal(new Set(labels.filter(Boolean)).size, labels.filter(Boolean).length, 'duplicate row labels');
    assert.ok(!labels.includes('MSP Levels') || r.pairs.some((p) => /D-SNP|Dual/i.test(p.plan27.planName)));
  });

  it('new plans show 2027 values with the New marker', () => {
    const premium = rowFor(m, 'Monthly Premium (CMS, before Extra Help)').cells[2];
    assert.equal(premium.v26, 'No 2026 plan');
    assert.equal(premium.change, 'New');
  });

  it('chat reply covers every plan', () => {
    assert.match(r.chatText, /H1036-054C \(Miami-Dade\)/);
    assert.match(r.chatText, /H5471-125 \(Miami-Dade\)/);
    assert.match(r.chatText, /New for 2027 — no 2026 plan/);
  });
});

describe('UI wiring', () => {
  it('inlines artifacts/year-compare.js in the page', () => {
    const js = fs.readFileSync(path.join(__dirname, '../artifacts/year-compare.js'), 'utf8').replace(/\s+$/, '');
    const start = html.indexOf('<!-- MAX_YEAR_COMPARE_BEGIN -->');
    const stop = html.indexOf('<!-- MAX_YEAR_COMPARE_END -->');
    assert.ok(start > 0 && stop > start);
    assert.ok(html.slice(start, stop).includes(js), 'run: node scripts/sync_html_artifacts.js yearcompare');
  });

  it('runs the year compare before the model call and renders its own export chips', () => {
    const send = html.indexOf('const sendNow = async');
    const yearAt = html.indexOf('runYearCompareFromChat(userMessageText(apiContent)', send);
    const askAt = html.indexOf('await askGuru(', send);
    assert.ok(yearAt > send && yearAt < askAt);
    assert.match(html, /data-testid="year-compare-offer"/);
    assert.match(html, /MaxYearCompare\.exportYearCompareToExcel\(m\.yearCompare\)/);
    assert.match(html, /MaxYearCompare\.exportYearCompareToPdf\(m\.yearCompare\)/);
  });

  it('keeps the 2027 default for every other ask', () => {
    assert.match(html, /const DEFAULT_PLAN_YEAR = 2027;/);
    assert.match(html, /if \(has27\) return 2027/);
  });
});

describe('2026 archive cleanup', () => {
  it('drops the bad Broward H0982-022 row (CMS has -022 in Miami-Dade only)', () => {
    const bad = plans2026.filter((p) => p.county === 'Broward' && /H0982-022/.test(String(p.planId)));
    assert.deepEqual(bad, []);
    assert.ok(plans2026.some((p) => p.county === 'Miami-Dade' && /H0982-022/.test(String(p.planId))));
    assert.ok(plans2026.some((p) => p.county === 'Broward' && /H0982-007/.test(String(p.planId))));
  });
});

describe('benefits-only New client (no doctors or meds): current plan by name', () => {
  it('"humana hmo giveback" in 33009 (Broward) is exactly Humana Gold Plus Giveback H1036-305', () => {
    const c = yc.planCandidatesByName('Kimberly Janiszewski , 33009, is currently on the humana hmo giveback. lets compare side by side with 2027 benefits. She has no drs or meds', plans2027);
    assert.deepEqual(c.map((x) => x.key), ['H1036-305']);
  });
  it('the Humana PPO giveback fits two plans, so it is ambiguous (never guessed)', () => {
    const c = yc.planCandidatesByName('33009 on the humana ppo giveback', plans2027);
    assert.deepEqual(c.map((x) => x.key).sort(), ['H7617-110', 'H7617-145']);
  });
  it('a plain "humana hmo" does not pick a giveback plan', () => {
    const c = yc.planCandidatesByName('33009 humana hmo', plans2027);
    assert.deepEqual(c.map((x) => x.key), ['H1036-065']);
  });
  it('no carrier named → no candidates', () => {
    assert.deepEqual(yc.planCandidatesByName('33009 on the giveback hmo', plans2027), []);
  });
  it('H1036-305 in Broward compares 2026 vs 2027 from the ZIP', () => {
    const r = run('Kimberly Janiszewski 33009 H1036-305 compare 2026 vs 2027');
    assert.ok(r.pairs.length);
    assert.match(r.chatText, /Giveback H1036-305 \(Broward\)/);
  });
  it('New client no longer stops on "no doctors or meds" when the plan resolves', () => {
    const src = html;
    assert.match(src, /benefitsOnlyIds/);
    assert.match(src, /planCandidatesByName\(rawText, PLAN_DATA_BY_YEAR\[2027\]\)/);
    assert.match(src, /found more than one plan that fits/);
  });
});
