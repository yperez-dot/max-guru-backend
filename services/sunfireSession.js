/**
 * Sunfire session helpers for Max.
 * Tokens are Railway env vars (SUNFIRE_JWT + SUNFIRE_SFP). Max owns refresh;
 * current Igor does not. Never log the raw token or cookie.
 */

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const DRUG_PROBE_PATH = '/v2/drug/search/met/-1';

function getSunfireEnv() {
  const jwt = typeof process.env.SUNFIRE_JWT === 'string' ? process.env.SUNFIRE_JWT.trim() : '';
  const sfp = typeof process.env.SUNFIRE_SFP === 'string' ? process.env.SUNFIRE_SFP.trim() : '';
  return { jwt, sfp };
}

/** Decode JWT payload without verifying the signature. Returns null if malformed. */
function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function jwtExpiry(jwt) {
  const payload = decodeJwtPayload(jwt);
  const exp = payload && Number(payload.exp);
  if (!exp || !Number.isFinite(exp)) return { expSec: null, expIso: null, expired: null };
  return {
    expSec: exp,
    expIso: new Date(exp * 1000).toISOString(),
    expired: Date.now() >= exp * 1000,
  };
}

function getHealthSnapshot(nowMs = Date.now()) {
  const { jwt, sfp } = getSunfireEnv();
  const exp = jwtExpiry(jwt);
  const expired = exp.expSec == null ? null : nowMs >= exp.expSec * 1000;
  return {
    jwtSet: Boolean(jwt),
    sfpSet: Boolean(sfp),
    jwtExp: exp.expIso,
    jwtExpired: expired,
  };
}

/**
 * Live ping of Sunfire drug search (JWT only).
 * Does not log tokens. Returns a JSON-safe status object.
 */
async function probeSunfire(fetchImpl = fetch, timeoutMs = 10000) {
  const { jwt, sfp } = getSunfireEnv();
  const health = getHealthSnapshot();
  if (!jwt) {
    return { ok: false, reason: 'missing_jwt', sunfireStatus: null, ...health };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${SUNFIRE_BASE}${DRUG_PROBE_PATH}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.ok) {
      return {
        ok: true,
        reason: 'ok',
        sunfireStatus: res.status,
        sfpPresent: Boolean(sfp),
        ...health,
      };
    }
    const expiredHttp = res.status === 401 || res.status === 403;
    return {
      ok: false,
      reason: expiredHttp ? 'session_expired' : 'sunfire_error',
      sunfireStatus: res.status,
      sfpPresent: Boolean(sfp),
      ...health,
    };
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return {
      ok: false,
      reason: timedOut ? 'timeout' : 'network_error',
      sunfireStatus: null,
      ...health,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  SUNFIRE_BASE,
  getSunfireEnv,
  decodeJwtPayload,
  jwtExpiry,
  getHealthSnapshot,
  probeSunfire,
};
