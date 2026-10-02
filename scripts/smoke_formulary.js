#!/usr/bin/env node
/**
 * Live smoke: Trintellix + Atorvastatin × H1036-054C / H1036-305 (2027).
 * claimedTier is discarded. Lookup is the only source.
 */
const { lookupFormulary, formatFormularyText, hasSunfireCreds } = require('../services/formularyLookup');
const { loadKnowledge } = require('../knowledge/loader');

loadKnowledge({ force: true });

const DRUGS = ['Trintellix', 'Atorvastatin'];
const PLANS = ['H1036-054C', 'H1036-305'];

(async () => {
  console.log('Sunfire JWT:', hasSunfireCreds() ? 'present' : 'missing');
  const summary = [];
  let failed = 0;
  for (const drugName of DRUGS) {
    const result = await lookupFormulary({
      drugName,
      planIds: PLANS,
      year: 2027,
      claimedTier: 4,
    });
    console.log('\n====', drugName, '====');
    console.log(formatFormularyText(result));
    if (result.claimedTier != null) {
      console.error('FAIL: claimedTier leaked');
      failed += 1;
    }
    for (const row of result.lookups) {
      summary.push({
        drug: drugName,
        plan: row.planId,
        verified: row.verified,
        tier: row.tier,
        costShare: row.costShare,
        source: row.source || row.reason || 'unverified',
      });
      if (!row.verified) failed += 1;
    }
  }
  console.log('\n==== SMOKE SUMMARY ====');
  for (const row of summary) {
    console.log(
      `${row.drug} × ${row.plan}: ${row.verified ? `VERIFIED T${row.tier} ${row.costShare || ''}`.trim() : 'UNVERIFIED'} source=${row.source}`
    );
  }
  if (failed) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
