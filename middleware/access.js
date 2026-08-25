/**
 * Shared access password for Max (invite-only).
 * When MAX_ACCESS_PASSWORD is set, /chat requires a short-lived access token
 * from POST /auth/unlock — so the Netlify-injected API key alone is not enough.
 */
const crypto = require('crypto');

const TOKEN_TTL_MS = Number(process.env.MAX_ACCESS_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function accessEnabled() {
  return Boolean(process.env.MAX_ACCESS_PASSWORD);
}

function signingSecret() {
  return `${process.env.MAX_API_KEY || ''}|${process.env.MAX_ACCESS_PASSWORD || ''}`;
}

function issueAccessToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp, v: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyAccessToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || Date.now() > Number(data.exp)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function requireAccessToken(req, res, next) {
  if (!accessEnabled()) return next();
  const token =
    req.headers['x-max-access-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyAccessToken(token)) {
    return res.status(401).json({ error: 'Access locked', code: 'access_required' });
  }
  next();
}

function unlockHandler(req, res) {
  if (!accessEnabled()) {
    return res.json({ ok: true, accessRequired: false, token: null });
  }
  const password = req.body?.password;
  const expected = process.env.MAX_ACCESS_PASSWORD;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password required' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = issueAccessToken();
  return res.json({
    ok: true,
    accessRequired: true,
    token,
    expiresInMs: TOKEN_TTL_MS,
  });
}

module.exports = {
  accessEnabled,
  requireAccessToken,
  unlockHandler,
  issueAccessToken,
  verifyAccessToken,
};
