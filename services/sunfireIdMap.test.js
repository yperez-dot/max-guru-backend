const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sunfireIdForPlan,
  sunfireMapHasYear,
  sunfireEntryYear,
  lookupSunfireCoverage,
} = require('./formularyLookup');

// Shaped like the rebuilt map: contract + PBP + year on every entry.
const MAP_2027 = {
  270101: { hRaw: 'H1045', pbp: '001', planName: 'UHC Preferred Medicare Advantage FL-0001 (HMO)', carrier: 'UnitedHealthcare', year: 2027 },
  270993: { hRaw: 'H1609', pbp: '093', planName: 'Aetna Medicare Eagle (HMO)', carrier: 'Aetna', year: 2027 },
  272355: { hRaw: 'H1036', pbp: '054', letter: 'C', planName: 'Humana Gold Plus (HMO)', carrier: 'Humana Inc.', year: 2027 },
  270007: { hRaw: 'H0982', pbp: '007', planName: 'Solis Healthy Living (HMO)', carrier: 'Solis Health Plans', year: 2027 },
};
// The old hand-made shape: 2026 ids, no pbp, CMS id only inside Humana's marketing name.
const MAP_2026 = {
  262355: { hRaw: 'H1036', planName: 'Humana Gold Plus H1036-054C (HMO)', carrier: 'Humana Inc.' },
  260101: { hRaw: 'H1045', planName: 'UHC Preferred Medicare Advantage FL-0001 (HMO)', carrier: 'UnitedHealthcare' },
};

describe('Sunfire plan-id mapping (Yahoska, 2026-10-07)', () => {
  it('resolves carriers that do not print the CMS id in the plan name', () => {
    // These returned null before: matching searched the marketing name, which only Humana carries.
    assert.equal(sunfireIdForPlan('H1045-001', MAP_2027, 2027), '270101');
    assert.equal(sunfireIdForPlan('H1609-093', MAP_2027, 2027), '270993');
    assert.equal(sunfireIdForPlan('H0982-007', MAP_2027, 2027), '270007');
    assert.equal(sunfireIdForPlan('H1036-054C', MAP_2027, 2027), '272355');
  });

  it('never returns another plan year’s id', () => {
    assert.equal(sunfireIdForPlan('H1045-001', MAP_2027, 2026), null);
    assert.equal(sunfireIdForPlan('H1036-054C', MAP_2026, 2027), null);
    assert.equal(sunfireIdForPlan('H1036-054C', MAP_2026, 2026), '262355');
  });

  it('does not confuse two PBPs on the same contract', () => {
    const map = {
      270001: { hRaw: 'H1045', pbp: '001', planName: 'UHC Preferred FL-0001 (HMO)', year: 2027 },
      270029: { hRaw: 'H1045', pbp: '029', planName: 'UHC MedicareMax FL-0029 (HMO)', year: 2027 },
    };
    assert.equal(sunfireIdForPlan('H1045-001', map, 2027), '270001');
    assert.equal(sunfireIdForPlan('H1045-029', map, 2027), '270029');
  });

  it('still reads the marketing name for old entries that have no pbp', () => {
    assert.equal(sunfireIdForPlan('H1036-054C', MAP_2026, 2026), '262355');
  });

  it('returns null for an unmapped plan or an unparseable id', () => {
    assert.equal(sunfireIdForPlan('H9999-000', MAP_2027, 2027), null);
    assert.equal(sunfireIdForPlan('', MAP_2027, 2027), null);
    assert.equal(sunfireIdForPlan('not-a-plan', MAP_2027, 2027), null);
  });

  it('reads the plan year from the id prefix or the entry', () => {
    assert.equal(sunfireEntryYear('272355', {}), 2027);
    assert.equal(sunfireEntryYear('262355', {}), 2026);
    assert.equal(sunfireEntryYear('272355', { year: 2026 }), 2026);
  });

  it('sunfireMapHasYear reports which years the map covers', () => {
    assert.equal(sunfireMapHasYear(2027, MAP_2027), true);
    assert.equal(sunfireMapHasYear(2026, MAP_2027), false);
    assert.equal(sunfireMapHasYear(2026, MAP_2026), true);
  });
});

describe('Sunfire coverage refuses a year mismatch instead of quoting the wrong year', () => {
  const noFetch = () => {
    throw new Error('Sunfire must not be called when the plan is unmapped for that year');
  };

  it('says the plan year has no ids rather than falling back to 2026', async (t) => {
    if (!process.env.SUNFIRE_JWT) process.env.SUNFIRE_JWT = 'test-only-not-a-real-token';
    const r = await lookupSunfireCoverage(
      { drug: { name: 'pregabalin' }, planId: 'H9999-000', year: 2027 },
      noFetch
    );
    assert.equal(r.verified, false);
    assert.match(r.reason, /sunfire_(no_2027_plan_ids|plan_not_mapped)/);
    assert.deepEqual(r.attempted, []);
  });

  it('an explicit sunfirePlanId is still honoured', async () => {
    if (!process.env.SUNFIRE_JWT) process.env.SUNFIRE_JWT = 'test-only-not-a-real-token';
    const r = await lookupSunfireCoverage(
      { drug: { name: 'pregabalin' }, planId: 'H9999-000', year: 2027, sunfirePlanId: '270101' },
      async () => ({ ok: false, status: 500, json: async () => null })
    );
    // It got past the guard and actually attempted a call.
    assert.notEqual(r.reason, 'sunfire_no_2027_plan_ids');
  });
});
