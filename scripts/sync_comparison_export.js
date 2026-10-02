#!/usr/bin/env node
/** Copy artifacts/comparison-export.js into the HTML inline block. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const jsPath = path.join(root, 'artifacts/comparison-export.js');
const htmlPath = path.join(root, 'artifacts/max-demo-FINAL-v7.html');
const begin = '<!-- MAX_COMPARISON_EXPORT_BEGIN -->';
const end = '<!-- MAX_COMPARISON_EXPORT_END -->';

const js = fs.readFileSync(jsPath, 'utf8').replace(/\s+$/, '');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf(begin);
const stop = html.indexOf(end);
if (start < 0 || stop < 0 || stop < start) {
  console.error('MAX_COMPARISON_EXPORT markers missing');
  process.exit(1);
}
const next = html.slice(0, start) + `${begin}\n<script>\n${js}\n</script>\n` + html.slice(stop);
fs.writeFileSync(htmlPath, next);
console.log('Synced comparison-export.js into max-demo-FINAL-v7.html');
