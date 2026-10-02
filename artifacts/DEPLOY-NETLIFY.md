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

## Excel / PDF export

Plan IDs like `H5420-001/0028` fuzzy-match grid IDs (`H5420-001/-0028`).
Asking for “excel” or “pdf” re-offers Export from the **latest** comparison only.

The file matches Yahoska’s sheet: client name title (when known), Plan Terminating only when she says a current plan is ending, marketing name + contract-PBP headers, Doctors first (In/Out / Not confirmed / Need more info when providers were checked or named), Medications immediately under Doctors (brand* + generic), then 2027 green-cell benefits, then SOB/EOC. SOB/EOC are hyperlinks when the plan has a URL, otherwise `SOB pending` / `EOC pending`. The HTML inlines the export script, so publishing `max-demo-FINAL-v7.html` as `index.html` is still a one-file deploy.

## Invite-only access (cost control)

Max is meant for Yahoska / Katy / Carolina — not the full agent roster.

1. Railway → Variables → set `MAX_ACCESS_PASSWORD` to a strong shared password
2. Redeploy Railway (automatic on variable change)
3. Share the password only with those three
4. Optional: Cloudflare Access on `max.healthexps.com` restricted to your three emails (strongest)
5. Optional: in https://console.x.ai set a monthly spend limit / alerts

Chat is also rate-limited (~40 requests / hour / session by default via `MAX_CHAT_RATE_MAX`).

## Client workups

The sidebar lists **Client workups** after unlock (Save / Update, Open, Delete). They live on Railway under that agent's unlock email, so desktop and phone share the same list. Opening a workup starts a fresh chat with one compact fact card — it does not replay the old thread into `/chat`. Excel/PDF export still uses the structured comparison payload.
