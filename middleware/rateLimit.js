/**
 * Simple in-memory rate limiter (per process). Good enough for a small Railway
 * replica to blunt accidental / abusive Grok spend.
 */
function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  function keyFrom(req) {
    const tok = req.headers['x-max-access-token'] || '';
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    return `${name}:${tok.slice(0, 16) || ip}`;
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
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
        error: `Too many Max requests — try again in ~${retrySec}s. This limit protects Grok spend.`,
        code: 'rate_limited',
      });
    }
    // Opportunistic cleanup
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now > v.resetAt) hits.delete(k);
      }
    }
    next();
  };
}

module.exports = { createRateLimiter };
