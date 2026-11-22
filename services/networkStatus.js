/**
 * Plan-level network status. In is only allowed when the directory listed THIS
 * plan at the client's location. A carrier-level hit is never In / In*.
 *
 * IN              confirmed listing for this plan at this location
 * OUT             finished check, not listed — or an out-of-network banner at the location
 * NOT_CONFIRMED   check ran, no plan-level evidence (partial list, missing plan row, unmapped network)
 * UNCHECKED       failed / pending / not run
 */
const STATUS = Object.freeze({
  IN: 'in',
  OUT: 'out',
  NOT_CONFIRMED: 'not_confirmed',
  UNCHECKED: 'unchecked',
});

function isOutOfNetworkBanner(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  return /out[- ]of[- ]network|\boon\b|\bnot\s+in[- ]network/i.test(s);
}

function isInNetworkBanner(status) {
  const s = String(status || '').trim();
  if (isOutOfNetworkBanner(s)) return false;
  return /(?:^|[^a-z])in[- ]?network\b/i.test(s) || /^inn$/i.test(s);
}

/**
 * Evidence for one (doctor, planId, location). Forbids In without a plan-level listing.
 * `sharedNetworkTwinIn` is the only extra path: a documented twin plan (Doctors C-SNP/D-SNP)
 * that was itself listed In.
 */
function planNetworkStatus(ev = {}) {
  const {
    planListedIn = false,
    planListedOut = false,
    locationOon = false,
    checkFailed = false,
    checkPending = false,
    directoryFinished = false,
    carrierHit = false,
    sharedNetworkTwinIn = false,
    partialDirectory = false,
    orgCompleteMiss = false,
  } = ev;
  if (checkFailed || checkPending) return STATUS.UNCHECKED;
  if (locationOon || planListedOut) return STATUS.OUT;
  if (planListedIn || sharedNetworkTwinIn) return STATUS.IN;
  if (orgCompleteMiss && directoryFinished) return STATUS.OUT;
  if (directoryFinished && !carrierHit && !partialDirectory) return STATUS.OUT;
  if (carrierHit || partialDirectory || (directoryFinished && !planListedIn)) return STATUS.NOT_CONFIRMED;
  return STATUS.UNCHECKED;
}

module.exports = {
  STATUS,
  isOutOfNetworkBanner,
  isInNetworkBanner,
  planNetworkStatus,
};
