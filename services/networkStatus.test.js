const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, isOutOfNetworkBanner, isInNetworkBanner, planNetworkStatus } = require('./networkStatus');

describe('network status enum', () => {
  it('never marks In without a plan-level listing at this location', () => {
    assert.equal(planNetworkStatus({ carrierHit: true, directoryFinished: true }), STATUS.NOT_CONFIRMED);
    assert.equal(planNetworkStatus({ planListedIn: true }), STATUS.IN);
    assert.equal(planNetworkStatus({ planListedIn: true, locationOon: true }), STATUS.OUT);
  });

  it('an out-of-network banner at the location is Out, not In', () => {
    assert.equal(isOutOfNetworkBanner('Out-of-network at this location'), true);
    assert.equal(isInNetworkBanner('Out-of-network at this location'), false);
    assert.equal(planNetworkStatus({
      planListedIn: true,
      locationOon: true,
      carrierHit: true,
      directoryFinished: true,
    }), STATUS.OUT);
  });

  it('a finished person miss is Out; a partial directory is not confirmed', () => {
    assert.equal(planNetworkStatus({ directoryFinished: true, carrierHit: false }), STATUS.OUT);
    assert.equal(planNetworkStatus({
      directoryFinished: true, carrierHit: false, partialDirectory: true,
    }), STATUS.NOT_CONFIRMED);
  });
});
