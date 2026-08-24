# Deploying Max frontend (Netlify)

The live UI is a single HTML file: `artifacts/max-demo-FINAL-v7.html`
→ publish as `index.html` on the `thei-max-guru` Netlify site.

## Excel export fix (2026-08-24)

Plan IDs like `H5420-001/0028` must fuzzy-match grid IDs (`H5420-001/-0028`).
Asking for “excel” / “export” now resurfaces the Export button from plans already in the thread.

## Publish

```bash
# From repo root — Netlify CLI (logged in as THEI):
cp artifacts/max-demo-FINAL-v7.html /tmp/max-index/index.html
npx netlify deploy --prod --dir=/tmp/max-index --site=thei-max-guru
```

Or drag-drop `artifacts/max-demo-FINAL-v7.html` renamed to `index.html` in the Netlify UI.

After publish, hard-refresh https://thei-max-guru.netlify.app/ and re-run a 2-plan comparison — the Export chip should appear; “need this in excel” should offer Export instead of refusing.
