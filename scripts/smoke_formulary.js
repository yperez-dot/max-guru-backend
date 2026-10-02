#!/usr/bin/env node
/**
 * Live smoke: Trintellix + Atorvastatin × H1036-054C / H1036-305 (2027).
 * Uses SUNFIRE_JWT when present; otherwise Humana FHIR. Never prints a claimed tier as verified.
 */
const { lookupFormulary, formatFormularyText, hasSunfireCreds } = require('../services/formularyLookup');
const { loadKnowledge } = require('../knowledge/loader');

loadKnowledge({ force: true });

const DRUGS = ['Trintellix', 'Atorvastatin'];
const PLANS = ['H1036-054C', 'H1036-305'];

(async () => {
  console.log('Sunfire JWT:', hasSunfireCreds() ? 'present' : 'missing');
  for (const drugName of DRUGS) {
    const result = await lookupFormulary({
      drugName,
      planIds: PLANS,
      year: 2027,
      claimedTier: 4,
    });
    console.log('\n====', drugName, '====');
    console.log(formatFormularyText(result));
    for (const row of result.lookups) {
      if (row.verified && row.tier === 4 && result.claimedTier === 4) {
        console.log('NOTE: verified tier happened to equal the claimed tier; source=', row.source);
      }
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
