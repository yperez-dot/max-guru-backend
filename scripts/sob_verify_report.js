#!/usr/bin/env node
/**
 * Bulk SOB check: run the real lookup for every 2027 plan and write one CSV row per
 * plan x field with the parsed value, where it came from, and a review flag.
 *
 *   node scripts/sob_verify_report.js            # all plans
 *   node scripts/sob_verify_report.js H4140-023  # one or more contract-PBPs
 *
 * Run it somewhere that can reach the carrier PDFs (Railway shell or your computer).
 * Review the CSV against the printed Summary of Benefits, then copy confirmed rows
 * (value + page + quote) into max-knowledge/sob-verified-2027.json. Nothing here
 * writes to that file automatically.
 */
const fs = require('fs');
const path = require('path');
const { lookupSobBenefits } = require('../services/sobLookup');

const HTML = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const OUT = path.join(__dirname, '../artifacts/reports/sob-verify-2027.csv');
const FIELDS = ['snfDays1to20', 'snfDays21to100', 'dme', 'dmeHospitalBed', 'hearingAids'];

function loadPlans() {
  const m = fs.readFileSync(HTML, 'utf8').match(/<script id="plan-data" type="application\/json">\s*(.*?)\s*<\/script>/s);
  return JSON.parse(m[1]);
}
const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

(async () => {
  const only = process.argv.slice(2).map((s) => s.toUpperCase());
  const seen = new Set();
  const plans = loadPlans().filter((p) => {
    const id = String(p.planId || p.id).toUpperCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return !only.length || only.includes(id);
  });
  const rows = [['planId', 'planName', 'sobUrl', 'field', 'value', 'source', 'review']];
  for (const plan of plans) {
    const id = plan.planId || plan.id;
    try {
      const res = await lookupSobBenefits({
        plans: [plan],
        planIds: [id],
        benefits: ['skilled_nursing', 'dme', 'hospital_bed', 'hearing_aids'],
        year: 2027,
      });
      const row = res.byPlanId[id] || res.lookups[0] || { fields: {} };
      FIELDS.forEach((f) => {
        const v = row.fields && row.fields[f];
        const value = v && v.value;
        const review = !plan.sobUrl
          ? 'NO SOB LINK'
          : value
            ? v.source === 'verified_sob' ? 'verified' : 'CHECK AGAINST PRINTED SOB'
            : `UNVERIFIED (${(v && v.reason) || 'unknown'})`;
        rows.push([id, plan.planName, plan.sobUrl, f, value, v && v.source, review]);
      });
    } catch (err) {
      rows.push([id, plan.planName, plan.sobUrl, '', '', '', `ERROR ${err.message}`]);
    }
    process.stderr.write(`${id} done\n`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rows.map((r) => r.map(esc).join(',')).join('\n') + '\n');
  console.log(`Wrote ${OUT} (${rows.length - 1} rows)`);
})();
