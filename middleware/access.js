/**
 * Invite-only access for Max.
 * Requires MAX_ACCESS_PASSWORD and an allowlisted email (MAX_ACCESS_EMAILS).
 * POST /auth/unlock { email, password } → short-lived access token.
 */
const crypto = require('crypto');

const TOKEN_TTL_MS = Number(process.env.MAX_ACCESS_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function accessEnabled() {
  return Boolean(process.env.MAX_ACCESS_PASSWORD);
}

function allowedEmails() {
  const raw = process.env.MAX_ACCESS_EMAILS || '';
  return raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function signingSecret() {
  return `${process.env.MAX_API_KEY || ''}|${process.env.MAX_ACCESS_PASSWORD || ''}`;
}

function issueAccessToken(email) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ exp, v: 2, email: String(email || '').toLowerCase() })
  ).toString('base64url');
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
    const emails = allowedEmails();
    if (emails.length && data.email && !emails.includes(String(data.email).toLowerCase())) {
      return false;
    }
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
  const emailRaw = req.body?.email;
  const expected = process.env.MAX_ACCESS_PASSWORD;
  const emails = allowedEmails();

  if (!emailRaw || typeof emailRaw !== 'string') {
    return res.status(400).json({ error: 'email required', code: 'email_required' });
  }
  const email = emailRaw.trim().toLowerCase();
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'valid email required', code: 'email_required' });
  }
  if (emails.length && !emails.includes(email)) {
    return res.status(401).json({ error: 'Email not authorized', code: 'email_denied' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password required' });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = issueAccessToken(email);
  return res.json({
    ok: true,
    accessRequired: true,
    token,
    email,
    expiresInMs: TOKEN_TTL_MS,
  });
}

module.exports = {
  accessEnabled,
  requireAccessToken,
  unlockHandler,
  issueAccessToken,
  verifyAccessToken,
  allowedEmails,
};
