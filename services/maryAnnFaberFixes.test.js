// Mary Ann Faber workup regressions, 2026-11-24 (ZIP 33172).
// Fictional reuse of the live ask shape; no extra PHI.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const { parseCompareAsk } = require('./compareJobs');
const DN = require('./drugNames');
const exp = require('../artifacts/comparison-export.js');

const ZIP = '33172';
const UHC = 'H5420-001';
const HUMANA = 'H1036-054C';
const DRMAX = 'H4140-022';
const ASK = `mary ann faber, ${ZIP}, drs: Dr. Melissa Guanche, Dr. Talia Zahra, Dr. Jonathan Dunn, Dr. Alan Chu, Dr. Carlos Samada, Dr. Alfredo Corpas (dentist). Medicatiions: almodipine, carvedilol, tramadol. Currently on UHC MedicareMax FL-0028 ${UHC}. Pls review Humana Gold Plus ${HUMANA} and Doctors DrMax-Dade ${DRMAX}`;
const FACTS = `Loaded workup — Mary Ann Faber
Continuing from structured facts only — not the old chat.
Client: Mary Ann Faber
ZIP/county: ${ZIP} Miami-Dade
Doctors (names only): Melissa Guanche; Talia Zahra; Jonathan Dunn; Alan Chu; Carlos Samada; Alfredo Corpas
Plans:
- UHC MedicareMax FL-0028 (${UHC})
- Humana Gold Plus (${HUMANA})
- Doctors DrMax-Dade (${DRMAX})
Current plan: ${UHC}
`;
const OFFER = 'Carlos J Samada is not in network on 3 of 3 checked plans — not "not confirmed on all of them". I can search other 2027 plans where they ARE in network — want me to?';
const OFFER2 = "Do you want me to look at those other carriers' Miami-Dade plans for Mary Ann, keeping her other doctors in the check?";

describe('Bug 1: typo med label never drops listed meds', () => {
  it('recognizes Medicatiions as a medications label, not medical/medicare', () => {
    assert.equal(R.isMedListLabel('Medicatiions'), true);
    assert.equal(R.isMedListLabel('medicatons'), true);
    assert.equal(R.isMedListLabel('medical'), false);
    assert.equal(R.isMedListLabel('medicare'), false);
    assert.equal(R.isMedListLabel('medicaid'), false);
    assert.match(R.normalizeMedListLabels('Medicatiions: almodipine'), /^Medications:/);
  });

  it('keeps almodipine, carvedilol and tramadol from the typo\'d label', () => {
    assert.deepEqual(R.medsFromAsk(ASK), ['almodipine', 'carvedilol', 'tramadol']);
    assert.deepEqual(parseCompareAsk(ASK).meds, ['almodipine', 'carvedilol', 'tramadol']);
  });

  it('fuzzy-resolves almodipine to amlodipine and still flags a true unknown as Confirm', async () => {
    DN._nameCache.clear();
    const fakeFetch = async (url) => {
      const u = String(url);
      const json = (obj) => ({ ok: true, text: async () => JSON.stringify(obj) });
      if (/\/rxcui\.json/.test(u) && /almodipine/.test(u)) return json({ idGroup: {} });
      if (/\/approximateTerm\.json/.test(u) && /almodipine/.test(u)) {
        return json({ approximateGroup: { candidate: [{ source: 'RXNORM', name: 'amlodipine', rxcui: '17767', score: 92 }] } });
      }
      if (/\/rxcui\/17767\/related\.json/.test(u)) {
        return json({ relatedGroup: { conceptGroup: [{ conceptProperties: [{ name: 'amlodipine' }] }] } });
      }
      if (/\/rxcui\.json/.test(u) && /zzzznotadrug/.test(u)) return json({ idGroup: {} });
      if (/\/approximateTerm\.json/.test(u) && /zzzznotadrug/.test(u)) return json({ approximateGroup: { candidate: [] } });
      if (/\/spellingsuggestions\.json/.test(u)) return json({ suggestionGroup: { suggestionList: { suggestion: [] } } });
      return json({});
    };
    const hit = await DN.resolveDrugName('almodipine', fakeFetch);
    assert.equal(hit.status, 'corrected');
    assert.equal(hit.name, 'amlodipine');

    DN._nameCache.clear();
    const miss = await DN.resolveDrugName('zzzznotadrug', fakeFetch);
    assert.equal(miss.status, 'not_found');
    const table = N.medsTable(
      [{ drugName: 'zzzznotadrug', inputName: 'zzzznotadrug', nameCheck: { status: 'not_found', input: 'zzzznotadrug' }, byPlanId: {} }],
      [{ planId: UHC, name: 'UHC MedicareMax FL-0028' }],
      ['zzzznotadrug']
    );
    assert.match(table, /zzzznotadrug/i);
    assert.match(table, /Confirm/);
    assert.doesNotMatch(table, /❓ check name/);
  });
});

describe('Bug 2: a yes to Max\'s own in-network search offer runs the search', () => {
  it('detects the offer and ignores a generic "want me to check?" closer', () => {
    assert.equal(N.inNetworkSearchOfferText(OFFER), true);
    assert.equal(N.inNetworkSearchOfferText(OFFER2), true);
    assert.equal(N.inNetworkSearchOfferText('Here is the comparison. Anything else you want me to check?'), false);
  });

  it('"yes pls search Carlos Samada" expands to the county core-plan search and keeps every saved doctor', () => {
    const msgs = [
      { role: 'user', content: FACTS },
      { role: 'assistant', content: OFFER },
      { role: 'user', content: 'yes pls search Carlos Samada' },
    ];
    assert.equal(N.acceptedInNetworkSearchOffer(msgs), true);
    const fu = N.comparisonFollowUp(msgs);
    assert.ok(fu);
    assert.match(fu.reason, /search other 2027 plans/i);
    assert.deepEqual(fu.doctors, [
      'Melissa Guanche',
      'Talia Zahra',
      'Jonathan Dunn',
      'Alan Chu',
      'Carlos Samada',
      'Alfredo Corpas',
    ]);
    const ask = N.comparisonAskText(msgs, ASK);
    assert.match(ask, /^Rank all eligible plans\.$/m);
    assert.ok(ask.includes(N.CORE_ALL_LINE));
  });
});

describe('Bug 3: current plan always comes first', () => {
  it('parseCompareAsk records H5420-001 as the current plan', () => {
    assert.deepEqual(parseCompareAsk(ASK).currentPlans, [UHC]);
  });

  it('chat columns and Excel/PDF lists put the current plan first even if Humana was listed first', () => {
    const shuffled = [
      { planId: HUMANA, name: 'Humana Gold Plus' },
      { planId: UHC, name: 'UHC MedicareMax FL-0028' },
      { planId: DRMAX, name: 'Doctors DrMax-Dade' },
    ];
    assert.deepEqual(exp.currentPlanFirst(shuffled, [UHC]).map((p) => p.planId), [UHC, HUMANA, DRMAX]);
    const tidy = exp.tidyExportPlans
      ? exp.tidyExportPlans(shuffled, FACTS, { currentPlanIds: [UHC] })
      : null;
    if (tidy) assert.deepEqual(tidy.map((p) => p.planId), [UHC, HUMANA, DRMAX]);
    // Loaded-workup facts (no "Currently on") still expose the current plan line.
    assert.deepEqual(exp.currentPlanIdsFromText(FACTS), [UHC]);
  });
});

describe('Bug 4: Medical Deductible and Chiropractic come from the 2027 grid', () => {
  let plans;
  before(() => {
    const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    const m = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(m, 'plan-data missing');
    plans = JSON.parse(m[1]);
  });
  function dade(id) {
    return plans.find((p) => (p.planId === id || p.id === id) && p.county === 'Miami-Dade');
  }
  it('maps FIELD_ROWS to planDeductible and chiropractic — not a typo key', () => {
    const keys = Object.fromEntries(exp.FIELD_ROWS);
    assert.equal(keys['Medical Deductible'], 'planDeductible');
    assert.equal(keys.Chiropractic, 'chiropractic');
  });
  it('fills the three Mary Ann plans from the grid instead of Not listed', () => {
    const expect = {
      [UHC]: { planDeductible: '$0', chiropractic: '$15; routine: not covered/not listed' },
      [HUMANA]: { planDeductible: '$0', chiropractic: "$0 (specialist's office); routine: not covered" },
      [DRMAX]: { planDeductible: '$0', chiropractic: '$0; routine 12 visits/yr $0 (self-refer to participating chiropractor)' },
    };
    for (const [id, want] of Object.entries(expect)) {
      const p = dade(id);
      assert.ok(p, `missing ${id}`);
      assert.equal(p.planDeductible, want.planDeductible);
      assert.equal(p.chiropractic, want.chiropractic);
      assert.equal(exp.formatBenefitValue(p.planDeductible, 'planDeductible'), '$0');
      assert.notEqual(exp.formatBenefitValue(p.chiropractic, 'chiropractic'), 'Not listed');
    }
  });
});
