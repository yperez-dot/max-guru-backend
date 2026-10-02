const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PREV = {
  MAX_API_KEY: process.env.MAX_API_KEY,
  MAX_ACCESS_PASSWORD: process.env.MAX_ACCESS_PASSWORD,
  MAX_ACCESS_EMAILS: process.env.MAX_ACCESS_EMAILS,
};

describe('access token identity', () => {
  before(() => {
    process.env.MAX_API_KEY = 'test-api-key';
    process.env.MAX_ACCESS_PASSWORD = 'test-password';
    process.env.MAX_ACCESS_EMAILS = 'yperez@healthexps.com,carolina@healthexps.com';
  });
  after(() => {
    Object.keys(PREV).forEach((key) => {
      if (PREV[key] == null) delete process.env[key];
      else process.env[key] = PREV[key];
    });
  });

  it('puts the unlock email on the request for workup scoping', () => {
    const access = require('../middleware/access');
    const token = access.issueAccessToken('yperez@healthexps.com');
    const decoded = access.decodeAccessToken(token);
    assert.equal(decoded.email, 'yperez@healthexps.com');
    const req = { headers: { 'x-max-access-token': token } };
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    let nextCalled = false;
    access.requireAccessToken(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(req.accessEmail, 'yperez@healthexps.com');
  });

  it('rejects a token for an email that is not allowlisted', () => {
    const access = require('../middleware/access');
    const token = access.issueAccessToken('stranger@example.com');
    assert.equal(access.verifyAccessToken(token), false);
  });
});
