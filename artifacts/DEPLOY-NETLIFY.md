# Deploying Max frontend (Netlify)

The live UI is a single HTML file: `artifacts/max-demo-FINAL-v7.html`
→ publish as `index.html` on the `thei-max-guru` Netlify site.

## Auth (required)

Do **not** commit `MAX_API_KEY` into the HTML. Inject it at publish time:

Netlify Site settings → Snippets → Before `</head>`:

```html
<script>window.MAX_API_KEY="YOUR_RAILWAY_MAX_API_KEY"</script>
```

Or when deploying from CLI:

```bash
KEY="$MAX_API_KEY" # from Railway / password manager — not from git
mkdir -p /tmp/max-index
{
  echo "<script>window.MAX_API_KEY=\"${KEY}\"</script>"
  cat artifacts/max-demo-FINAL-v7.html
} > /tmp/max-index/index.html
npx netlify deploy --prod --dir=/tmp/max-index --site=<site-id>
```

## Excel export fix

Plan IDs like `H5420-001/0028` fuzzy-match grid IDs (`H5420-001/-0028`).
Asking for “excel” re-offers Export from the **latest** comparison only.
