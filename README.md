# Max Guru Backend

AI knowledge assistant API for THEI Medicare agents. Deployed on Railway; frontend on Netlify (`thei-max-guru.netlify.app`).

## Quick start

```bash
cp .env.example .env
# fill ANTHROPIC_API_KEY and MAX_API_KEY (and Sunfire vars if testing lookups)
npm ci
npm start
```

## Auth

When `MAX_API_KEY` is set, every route except `GET /health` requires:

```
X-Max-Api-Key: <MAX_API_KEY>
```

or `Authorization: Bearer <MAX_API_KEY>`.

Configure the same value in the Netlify frontend request headers. Leaving `MAX_API_KEY` unset keeps the API open (dev only) and logs a startup warning.

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/health` | no | Liveness |
| GET | `/knowledge` | yes | KB index |
| GET | `/drug-search?name=` | yes | Sunfire drug search |
| POST | `/provider-lookup` | yes | `{ doctorName, zip, state? }` |
| POST | `/chat` | yes | `{ messages, system? }` |

## Notes

- Pass-through `/chat` (with `system`) is used by the Netlify app. The server caps prompt size, appends tool-use rules, redacts message bodies from logs, and pre-runs provider lookups when a doctor question is detected.
- Provider network logic lives in `services/providerNetwork.js` (shared by the HTTP route and chat tools).
- `max-knowledge/` is still loaded for tool search; the Netlify HTML system prompt remains the primary plan-grid source for pass-through mode.
