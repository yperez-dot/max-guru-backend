#!/usr/bin/env node
/** Copy a JS artifact into matching HTML comment markers. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'artifacts/max-demo-FINAL-v7.html');

function syncBlock(jsRel, begin, end) {
  const js = fs.readFileSync(path.join(root, jsRel), 'utf8').replace(/\s+$/, '');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf(begin);
  const stop = html.indexOf(end);
  if (start < 0 || stop < 0 || stop < start) {
    console.error(`${begin} markers missing`);
    process.exit(1);
  }
  const next = html.slice(0, start) + `${begin}\n<script>\n${js}\n</script>\n` + html.slice(stop);
  fs.writeFileSync(htmlPath, next);
  console.log(`Synced ${jsRel} into max-demo-FINAL-v7.html`);
}

if (require.main === module) {
  const which = process.argv[2] || 'all';
  if (which === 'all' || which === 'export') {
    syncBlock(
      'artifacts/comparison-export.js',
      '<!-- MAX_COMPARISON_EXPORT_BEGIN -->',
      '<!-- MAX_COMPARISON_EXPORT_END -->'
    );
  }
  if (which === 'all' || which === 'workups') {
    syncBlock(
      'artifacts/client-workups.js',
      '<!-- MAX_CLIENT_WORKUPS_BEGIN -->',
      '<!-- MAX_CLIENT_WORKUPS_END -->'
    );
  }
}

module.exports = { syncBlock };
