#!/usr/bin/env node
/** Copy artifacts/comparison-export.js into the HTML inline block. */
const { syncBlock } = require('./sync_html_artifacts.js');
syncBlock(
  'artifacts/comparison-export.js',
  '<!-- MAX_COMPARISON_EXPORT_BEGIN -->',
  '<!-- MAX_COMPARISON_EXPORT_END -->'
);
