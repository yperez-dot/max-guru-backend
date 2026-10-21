// Carolina Robles (2026-10-21): a Broward Doctors Select comparison exported the Miami-Dade grid row —
// Outpatient Hospital "$75" instead of Broward's "$50 / $75". The export guessed the county from words
// ("Miami" anywhere → Miami-Dade). The county is her ZIP first, then a county she named, then the plans'.
// Anonymized client; values read from the live 2027 plan-data (synced from the THEI grid).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const exp = require('../artifacts/comparison-export.js');
const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
const PLANS = JSON.parse(html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/)[1]);
const plan = (id, county) => PLANS.find((p) => p.planId === id && p.county === county);

function exportRows(planObjs, text, extra) {
  const payload = exp.buildExportPayload(planObjs, text, { catalog: PLANS, askText: text, userMessages: [text], ...(extra || {}) });
  const model = exp.buildComparisonModel(payload, {});
  const row = (label) => (model.aoa.find((r) => r[0] === label) || []).slice(1);
  return { payload, row };
}

describe('export county row (Broward vs Miami-Dade)', () => {
  it('grid values differ by county for Doctors Select H4140-023 (fixture sanity)', () => {
    assert.equal(plan('H4140-023', 'Broward').outpatientHospital, '$50 / $75');
    assert.equal(plan('H4140-023', 'Miami-Dade').outpatientHospital, '$75');
  });

  it('Broward ZIP + a Miami doctor → Broward row ($50 / $75, Unlimited transportation)', () => {
    const t = 'Client ZIP 33023 (Broward). Pat Test sees Dr. A in Miami Gardens. Compare H4140-023 and H4140-024, export to PDF.';
    const { payload, row } = exportRows([plan('H4140-023', 'Miami-Dade'), plan('H4140-024', 'Miami-Dade')], t);
    assert.deepEqual(payload.plans.map((p) => p.county), ['Broward', 'Broward']);
    assert.equal(row('Outpatient Hospital')[0], '$50 / $75');
    assert.equal(row('Transportation')[0], 'Unlimited');
    assert.equal(row('Ambulance')[0], '$125');
  });

  it('ZIP-only Broward ask (no county word) → Broward row', () => {
    const t = 'Pat Test, 33024. Show H4140-023 on the comparison sheet.';
    const { payload, row } = exportRows([plan('H4140-023', 'Miami-Dade')], t);
    assert.equal(payload.plans[0].county, 'Broward');
    assert.equal(row('Outpatient Hospital')[0], '$50 / $75');
  });

  it('workup ZIP/county passed as extras wins over thread words', () => {
    const t = 'Compare H4140-023 for her, doctor is at Miami-Dade Medical Plaza.';
    const { payload } = exportRows([plan('H4140-023', 'Miami-Dade')], t, { zip: '33023', county: 'Broward' });
    assert.equal(payload.plans[0].county, 'Broward');
  });

  it('workup context line "ZIP/county: 33023 / Broward" → Broward', () => {
    const t = 'Loaded workup — ZIP/county: 33023 / Broward\nCompare H4140-023 and H5431-006 in Miami';
    const { payload, row } = exportRows([plan('H4140-023', 'Miami-Dade'), plan('H5431-006', 'Miami-Dade')], t);
    assert.deepEqual(payload.plans.map((p) => p.county), ['Broward', 'Broward']);
    assert.equal(row('Transportation')[1], plan('H5431-006', 'Broward').transportation.replace(/\n/g, '\n'));
  });

  it('Miami-Dade ZIP stays Miami-Dade even when Broward is mentioned', () => {
    const t = 'Client ZIP 33176. Her daughter lives in Broward. Compare H4140-023.';
    const { payload, row } = exportRows([plan('H4140-023', 'Broward')], t);
    assert.equal(payload.plans[0].county, 'Miami-Dade');
    assert.equal(row('Outpatient Hospital')[0], '$75');
  });

  it('no ZIP and no county → the plan keeps the county row it carries', () => {
    const t = 'Compare H4140-023 for Pat Test.';
    const { payload } = exportRows([plan('H4140-023', 'Broward')], t);
    assert.equal(payload.plans[0].county, 'Broward');
  });

  it('helpers: ZIP → county and labeled ZIP parsing', () => {
    assert.equal(exp.countyForZip('33023'), 'Broward');
    assert.equal(exp.countyForZip('33176'), 'Miami-Dade');
    assert.equal(exp.clientZipFromText('Client ZIP: 33023. Dr. office 33136'), '33023');
    const c = exp.exportCountyFor('ZIP 33063, doctor in Miami', {}, []);
    assert.deepEqual(c, { county: 'Broward', sure: true });
  });
});
