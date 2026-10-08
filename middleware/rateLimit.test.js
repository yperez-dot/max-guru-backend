const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter, clientIp } = require('./rateLimit');
const { issueAccessToken } = require('./access');

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

/** Run one request through the limiter; true = allowed (next() called). */
function hit(limiter, req) {
  let passed = false;
  const res = fakeRes();
  limiter({ headers: {}, ...req }, res, () => { passed = true; });
  return { passed, res };
}

describe('chat limiter is per agent (req.accessEmail)', () => {
  it('two emails whose tokens share the same expiry prefix get separate buckets', () => {
    const prevKey = process.env.MAX_API_KEY;
    const prevPw = process.env.MAX_ACCESS_PASSWORD;
    process.env.MAX_API_KEY = 'test-key';
    process.env.MAX_ACCESS_PASSWORD = 'test-pw';
    const realNow = Date.now;
    try {
      Date.now = () => 1_790_000_000_000; // both unlocked at the same moment → same exp
      const tokA = issueAccessToken('agent.a@healthexps.com');
      const tokB = issueAccessToken('agent.b@healthexps.com');
      // The old key (first 16 chars of the token) was identical for both agents.
      assert.equal(tokA.slice(0, 16), tokB.slice(0, 16));
    } finally {
      Date.now = realNow;
      process.env.MAX_API_KEY = prevKey;
      process.env.MAX_ACCESS_PASSWORD = prevPw;
    }

    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, name: 'chat', keyBy: 'agent' });
    const a = { accessEmail: 'agent.a@healthexps.com', headers: { 'x-max-access-token': 'eyJleHAiOjE3OTIwSAME.sigA', 'x-real-ip': '1.1.1.1' } };
    const b = { accessEmail: 'agent.b@healthexps.com', headers: { 'x-max-access-token': 'eyJleHAiOjE3OTIwSAME.sigB', 'x-real-ip': '1.1.1.1' } };
    assert.equal(hit(limiter, a).passed, true);
    assert.equal(hit(limiter, a).passed, true);
    const third = hit(limiter, a);
    assert.equal(third.passed, false);
    assert.equal(third.res.statusCode, 429);
    assert.equal(third.res.body.code, 'rate_limited');
    // Agent B (same office IP, same token prefix) is untouched by A's usage.
    assert.equal(hit(limiter, b).passed, true);
    assert.equal(hit(limiter, b).passed, true);
    assert.equal(hit(limiter, b).passed, false);
  });

  it('the same agent on phone and desktop (different IPs) shares one bucket', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, name: 'chat', keyBy: 'agent' });
    const email = 'yperez@healthexps.com';
    assert.equal(hit(limiter, { accessEmail: email, headers: { 'x-real-ip': '10.0.0.1' } }).passed, true);
    assert.equal(hit(limiter, { accessEmail: email, headers: { 'x-real-ip': '10.0.0.2' } }).passed, true);
    assert.equal(hit(limiter, { accessEmail: email, headers: { 'x-real-ip': '10.0.0.3' } }).passed, false);
  });

  it('email casing does not create a second bucket', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, name: 'chat', keyBy: 'agent' });
    assert.equal(hit(limiter, { accessEmail: 'Katy@HealthExps.com' }).passed, true);
    assert.equal(hit(limiter, { accessEmail: 'katy@healthexps.com' }).passed, false);
  });

  it('falls back to the client IP when there is no agent email (or the gate is off)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, name: 'chat', keyBy: 'agent' });
    assert.equal(hit(limiter, { headers: { 'x-real-ip': '2.2.2.2' } }).passed, true);
    assert.equal(hit(limiter, { accessEmail: 'ungated', headers: { 'x-real-ip': '2.2.2.2' } }).passed, false);
    assert.equal(hit(limiter, { headers: { 'x-real-ip': '3.3.3.3' } }).passed, true);
  });

  it('the window resets', () => {
    let now = 1000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, name: 'chat', keyBy: 'agent', now: () => now });
    const req = { accessEmail: 'a@x.com' };
    assert.equal(hit(limiter, req).passed, true);
    const blocked = hit(limiter, req);
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.headers['retry-after'], '1');
    now = 2501;
    assert.equal(hit(limiter, req).passed, true);
  });
});

describe('unlock limiter is per IP only', () => {
  it('a new random X-Max-Access-Token header each try does NOT get a fresh bucket', () => {
    const limiter = createRateLimiter({ windowMs: 15 * 60_000, max: 3, name: 'unlock', keyBy: 'ip' });
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(hit(limiter, { headers: { 'x-real-ip': '9.9.9.9', 'x-max-access-token': `forged-${i}-${Math.random()}` } }).passed);
    }
    assert.deepEqual(results, [true, true, true, false, false, false]);
  });

  it('ignores accessEmail too (unlock happens before any token exists)', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, name: 'unlock', keyBy: 'ip' });
    assert.equal(hit(limiter, { accessEmail: 'a@x.com', headers: { 'x-real-ip': '4.4.4.4' } }).passed, true);
    assert.equal(hit(limiter, { accessEmail: 'b@x.com', headers: { 'x-real-ip': '4.4.4.4' } }).passed, false);
    assert.equal(hit(limiter, { headers: { 'x-real-ip': '5.5.5.5' } }).passed, true);
  });

  it('a forged leftmost X-Forwarded-For entry does not change the key', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, name: 'unlock', keyBy: 'ip' });
    assert.equal(hit(limiter, { headers: { 'x-forwarded-for': '6.6.6.1, 7.7.7.7' } }).passed, true);
    assert.equal(hit(limiter, { headers: { 'x-forwarded-for': '6.6.6.2, 7.7.7.7' } }).passed, false);
  });
});

describe('clientIp', () => {
  it('prefers X-Real-IP (set by the Railway edge), then the last XFF hop, then the socket', () => {
    assert.equal(clientIp({ headers: { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.2.3.4' } }), '8.8.8.8');
    assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '5.6.7.8');
    assert.equal(clientIp({ headers: {}, ip: '::1' }), '::1');
    assert.equal(clientIp({ headers: {} }), 'unknown');
  });

  it('rejects an unknown keyBy', () => {
    assert.throws(() => createRateLimiter({ windowMs: 1, max: 1, name: 'x', keyBy: 'token' }), /keyBy/);
  });
});
