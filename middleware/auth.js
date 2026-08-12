/**
 * Shared-secret auth for Max API routes.
 *
 * When MAX_API_KEY is set, require header:
 *   X-Max-Api-Key: <key>
 *   or Authorization: Bearer <key>
 *
 * Health checks stay public. If MAX_API_KEY is unset, requests are allowed
 * but a one-time startup warning is emitted (fail-open for local/dev only).
 */

function extractApiKey(req) {
  const headerKey = req.get('x-max-api-key');
  if (headerKey) return headerKey.trim();

  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();

  return '';
}

function requireApiKey(req, res, next) {
  const expected = process.env.MAX_API_KEY;
  if (!expected) return next();

  const provided = extractApiKey(req);
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function warnIfApiKeyMissing() {
  if (!process.env.MAX_API_KEY) {
    console.warn(
      '[auth] MAX_API_KEY is not set — API routes are open. Set MAX_API_KEY in Railway and send X-Max-Api-Key from the frontend.'
    );
  }
}

module.exports = { requireApiKey, extractApiKey, warnIfApiKeyMissing };
