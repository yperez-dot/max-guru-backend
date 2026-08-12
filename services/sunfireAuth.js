/**
 * Normalize Sunfire auth env vars.
 * SUNFIRE_JWT may be stored raw or already prefixed with "Bearer ".
 */

function sunfireAuthorizationHeader() {
  const raw = (process.env.SUNFIRE_JWT || '').trim();
  if (!raw) return '';
  return /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
}

function sunfireCookieHeader() {
  const sfp = (process.env.SUNFIRE_SFP || '').trim();
  if (!sfp) return '';
  return `sfp-cookie=${sfp}`;
}

function hasSunfireCredentials() {
  return Boolean((process.env.SUNFIRE_JWT || '').trim() && (process.env.SUNFIRE_SFP || '').trim());
}

module.exports = {
  sunfireAuthorizationHeader,
  sunfireCookieHeader,
  hasSunfireCredentials,
};
