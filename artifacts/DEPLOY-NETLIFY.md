# Deploying Max frontend (Netlify)

The live UI is a single HTML file: `artifacts/max-demo-FINAL-v7.html`
→ publish as `index.html` on the `thei-max-guru` Netlify site.

## Custom domain

Primary URL: **https://max.healthexps.com**

Netlify site `thei-max-guru` already has `custom_domain=max.healthexps.com`.
In **Cloudflare** (healthexps.com DNS), add:

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `max` | `thei-max-guru.netlify.app` | DNS only (grey cloud) **or** Proxied |

After DNS propagates, Netlify provisions SSL automatically.
`thei-max-guru.netlify.app` keeps working as a fallback.

Railway CORS allowlists `https://max.healthexps.com`.

## Model backend

Max's Railway `/chat` proxy calls **xAI Grok** (`GROK_MODEL`, default `grok-4.6`).
Set `XAI_API_KEY` on Railway before merge/cutover or chat returns 503.

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
