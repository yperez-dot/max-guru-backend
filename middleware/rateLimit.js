/**
 * Simple in-memory rate limiter (per process). Good enough for a small Railway
 * replica to blunt accidental / abusive LLM spend.
 *
 * Bucket keys (AEP audit, 2026-10-08):
 *   keyBy 'agent' (chat): one bucket per unlocked agent — req.accessEmail, set by
 *     requireAccessToken from the SIGNED token — falling back to the client IP.
 *     The old key was the first 16 chars of the raw token. That prefix is base64 of
 *     `{"exp":NNNNN`, so every agent who unlocked within the same ~28 h shared ONE bucket.
 *   keyBy 'ip' (unlock / password attempts): the client IP only. The old key trusted the
 *     client-controlled X-Max-Access-Token header, so sending a new random header each
 *     try got a fresh bucket and the password could be brute-forced.
 */

/**
 * Client IP. Railway's public edge documents X-Real-IP as the client's remote IP and
 * overwrites any caller-sent copy (docs.railway.com/networking/public-networking/specs-and-limits),
 * so it is the rate-limit key. Off Railway (local / tests) fall back to the LAST
 * X-Forwarded-For entry (the hop our own proxy added — the leftmost one is whatever the
 * caller typed), then the socket address.
 */
function clientIp(req) {
  const headers = (req && req.headers) || {};
  const real = String(headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = String(headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
}

function agentKey(req) {
  const email = String((req && req.accessEmail) || '').trim().toLowerCase();
  // 'ungated' = access gate off; every caller has the same pseudo-email, so use the IP.
  if (email && email !== 'ungated') return `agent:${email}`;
  return `ip:${clientIp(req)}`;
}

function createRateLimiter({ windowMs, max, name, keyBy = 'agent', now: nowFn = Date.now }) {
  if (keyBy !== 'agent' && keyBy !== 'ip') throw new Error(`rateLimit keyBy must be 'agent' or 'ip' (got ${keyBy})`);
  const hits = new Map();

  function keyFrom(req) {
    return `${name}:${keyBy === 'ip' ? `ip:${clientIp(req)}` : agentKey(req)}`;
  }

  function rateLimit(req, res, next) {
    const now = nowFn();
    const key = keyFrom(req);
    let bucket = hits.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({
        error: `Too many Max requests — try again in ~${retrySec}s. This limit protects LLM spend.`,
        code: 'rate_limited',
      });
    }
    // Opportunistic cleanup
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now > v.resetAt) hits.delete(k);
      }
    }
    return next();
  }
  rateLimit.keyFrom = keyFrom;
  return rateLimit;
}

module.exports = { createRateLimiter, clientIp, agentKey };
