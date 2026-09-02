const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeJwtPayload,
  jwtExpiry,
  getHealthSnapshot,
  probeSunfire,
} = require('./sunfireSession');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('decodeJwtPayload', () => {
  it('reads a normal payload', () => {
    const jwt = makeJwt({ exp: 1700000000, sub: 'broker' });
    assert.equal(decodeJwtPayload(jwt).sub, 'broker');
    assert.equal(decodeJwtPayload(jwt).exp, 1700000000);
  });

  it('returns null for garbage', () => {
    assert.equal(decodeJwtPayload(''), null);
    assert.equal(decodeJwtPayload('not-a-jwt'), null);
    assert.equal(decodeJwtPayload(null), null);
  });
});

describe('jwtExpiry', () => {
  it('flags an expired token', () => {
    const jwt = makeJwt({ exp: 1 });
    const info = jwtExpiry(jwt);
    assert.equal(info.expired, true);
    assert.equal(info.expIso, '1970-01-01T00:00:01.000Z');
  });

  it('flags a future token as not expired', () => {
    const jwt = makeJwt({ exp: 4102444800 }); // 2100-01-01
    assert.equal(jwtExpiry(jwt).expired, false);
  });
});

describe('getHealthSnapshot', () => {
  it('reports missing tokens', () => {
    const prevJwt = process.env.SUNFIRE_JWT;
    const prevSfp = process.env.SUNFIRE_SFP;
    delete process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_SFP;
    try {
      const snap = getHealthSnapshot();
      assert.deepEqual(snap, {
        jwtSet: false,
        sfpSet: false,
        jwtExp: null,
        jwtExpired: null,
      });
    } finally {
      if (prevJwt == null) delete process.env.SUNFIRE_JWT;
      else process.env.SUNFIRE_JWT = prevJwt;
      if (prevSfp == null) delete process.env.SUNFIRE_SFP;
      else process.env.SUNFIRE_SFP = prevSfp;
    }
  });
});

describe('probeSunfire', () => {
  it('returns missing_jwt when unset', async () => {
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    try {
      const result = await probeSunfire(async () => {
        throw new Error('should not fetch');
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'missing_jwt');
    } finally {
      if (prev == null) delete process.env.SUNFIRE_JWT;
      else process.env.SUNFIRE_JWT = prev;
    }
  });

  it('maps Sunfire 401 to session_expired', async () => {
    process.env.SUNFIRE_JWT = makeJwt({ exp: 4102444800 });
    process.env.SUNFIRE_SFP = 'cookie';
    try {
      const result = await probeSunfire(async () => ({ ok: false, status: 401 }));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'session_expired');
      assert.equal(result.sunfireStatus, 401);
    } finally {
      delete process.env.SUNFIRE_JWT;
      delete process.env.SUNFIRE_SFP;
    }
  });

  it('returns ok on Sunfire 200', async () => {
    process.env.SUNFIRE_JWT = makeJwt({ exp: 4102444800 });
    try {
      const result = await probeSunfire(async () => ({ ok: true, status: 200 }));
      assert.equal(result.ok, true);
      assert.equal(result.reason, 'ok');
    } finally {
      delete process.env.SUNFIRE_JWT;
    }
  });
});
