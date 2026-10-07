#!/usr/bin/env node
/**
 * Florida ZIP → county list from the Census 2020 ZCTA↔county relationship file.
 *   curl -sLO https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
 *   node scripts/build_fl_zip_county.js tab20_zcta520_county20_natl.txt > data/fl-zip-county.json
 * Each ZIP lists its counties by land area, largest first; a county holding under 10% of the
 * ZIP's land is dropped. Used to scope county PDF directories (Solis, Doctors) to her county.
 */
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: build_fl_zip_county.js <tab20_zcta520_county20_natl.txt>'); process.exit(1); }
const rows = fs.readFileSync(file, 'utf8').split('\n').slice(1).map((l) => l.split('|'));
const byZip = {};
for (const r of rows) {
  const zip = r[1];
  const fips = r[9];
  if (!zip || !fips || !fips.startsWith('12')) continue; // Florida only
  const county = String(r[10] || '').replace(/ County$/, '');
  const land = Number(r[16]) || 0;
  (byZip[zip] = byZip[zip] || []).push({ county, land });
}
const out = {};
for (const zip of Object.keys(byZip).sort()) {
  const parts = byZip[zip].sort((a, b) => b.land - a.land);
  const total = parts.reduce((s, p) => s + p.land, 0) || 1;
  out[zip] = parts.filter((p, i) => i === 0 || p.land / total >= 0.1).map((p) => p.county);
}
process.stdout.write(`${JSON.stringify({ source: 'Census 2020 ZCTA-county relationship file (tab20_zcta520_county20_natl)', zips: out })}\n`);
