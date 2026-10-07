// Regression: Gail Carreno compare export (2026-10-07). Each block is one bug from that
// Excel file; the fixture mirrors the live chat (services/fixtures/gailCarreno.js).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const exp = require('../artifacts/comparison-export.js');
const fx = require('./fixtures/gailCarreno');
const { drugCatalogQuery, pickCatalogMatch, drugIngredients, resolveMedicareGovNdcs, toExportDrug } = require('./formularyLookup');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');

const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
const catalog = JSON.parse(html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/)[1]);
const pick = (id) => catalog.find((p) => p.planId === id && p.county === 'Miami-Dade') || catalog.find((p) => p.planId === id);
const clone = (x) => JSON.parse(JSON.stringify(x));

function gailExport(overrides) {
  const remembered = fx.rememberedPlanIds.map(pick);
  const payload = exp.buildExportPayload(remembered.slice(0, 8), fx.threadText, Object.assign({
    catalog,
    clientName: 'Gail Carreno',
    askText: fx.userMessages.join('\n'),
    userMessages: fx.userMessages,
    latestUserText: fx.userMessages[fx.userMessages.length - 1],
    rememberedPlans: remembered,
    doctors: clone(fx.rememberedDoctors),
    drugs: clone(fx.drugs),
    providerLookups: clone(fx.providerLookups),
  }, overrides || {}));
  const model = exp.buildComparisonModel(payload);
  const ids = payload.plans.map((p) => exp.displayContractPbp(p));
  const docRows = model.doctors.map((d) => [d.name, ...d.statuses]);
  const drugRow = (re) => {
    const r = model.aoa.find((row) => re.test(String(row[0] || '')));
    return r ? r.slice(1) : null;
  };
  return { payload, model, ids, docRows, drugRow };
}

describe('Gail export: plan columns are her working set, not every plan in the thread', () => {
  it('latest explicit list + "add this plan too" → 4 columns (was 11)', () => {
    const { ids } = gailExport();
    assert.deepEqual(ids.slice().sort(), ['H1036-121', 'H1290-085', 'H5420-001', 'H5420-014']);
    for (const stale of ['H1609-093', 'H5431-001', 'H5431-006', 'H5431-017', 'H1045-018', 'H1036-305']) {
      assert.ok(!ids.includes(stale), `${stale} must not be a column`);
    }
  });

  it('workingPlanIdsFromUserMessages: reset on a 2+ list, add/remove after, ignore bare mentions', () => {
    const w = exp.workingPlanIdsFromUserMessages;
    assert.deepEqual(w(fx.userMessages), ['H1036-121', 'H5420-014', 'H1290-085', 'H5420-001']);
    assert.deepEqual(w(['compare H1036-054C and H1036-121', 'drop H1036-121', 'also add H5420-14-0']), ['H1036-054C', 'H5420-014']);
    assert.deepEqual(w(['Check the grid again, H1036-121 does list the chronic conditions']), []);
    assert.equal(exp.normalizeTypedPlanId('H5420-14-0'), 'H5420-014');
  });

  it('without her messages (old callers) the previous resolution is unchanged', () => {
    const { ids } = gailExport({ userMessages: undefined });
    assert.ok(ids.length > 4);
  });
});

describe('Gail export: one row per doctor, only names she typed', () => {
  it('aliases and corrections collapse; "Dr. Full Name" (Max template) is not a row', () => {
    const { docRows } = gailExport();
    const names = docRows.map((r) => r[0]);
    assert.equal(names.length, 6, names.join(', '));
    assert.ok(!names.some((n) => /full name/i.test(n)));
    assert.ok(names.includes('Dr. Natalia Rincon Buendia'));
    assert.ok(names.includes('Dr. Elie R Haddad'), 'her correction "Elie R Haddad" names the row');
    assert.ok(names.includes('Dr. Rawan Jumean-Haddad'), 'her latest spelling (rawan jumean-haddad) names the row');
    assert.equal(names.filter((n) => /rincon/i.test(n)).length, 1);
    assert.equal(names.filter((n) => /jumean|rawan|rowan/i.test(n)).length, 1);
    assert.equal(names.filter((n) => /haddad/i.test(n) && !/jumean/i.test(n)).length, 1);
  });

  it('the latest lookup wins per plan: Rincon re-run reads In on Humana H1036-121', () => {
    const { ids, docRows } = gailExport();
    const rincon = docRows.find((r) => /rincon/i.test(r[0]));
    assert.equal(rincon[1 + ids.indexOf('H1036-121')], exp.NETWORK_IN);
  });

  it('identity helpers: NPI decides; Eli~Elie, Rowan~Rawan; different first names stay apart', () => {
    const id = exp.doctorIdentity;
    assert.ok(exp.sameDoctorIdentity(id('Eli Haddad'), id('Elie R Haddad')));
    assert.ok(exp.sameDoctorIdentity(id('Rowan Jumean-Haddad'), id('RAWAN H JUMEAN')));
    assert.ok(exp.sameDoctorIdentity(id('Rawan Haddad'), id('Rowan Jumean-Haddad')));
    assert.ok(!exp.sameDoctorIdentity(id('Rawan Haddad'), id('Elie R Haddad')));
    assert.ok(!exp.sameDoctorIdentity(id('Jose Garcia'), id('Josefina Garcia')));
    assert.ok(!exp.sameDoctorIdentity(id('Eli Haddad', '1740242361'), id('Elie Haddad', '1184715435')));
  });

  it('a name only Max wrote never becomes a row (even with "Dr." in front)', () => {
    const text = fx.threadText + '\nYou could also look at Dr. Alberto Fakename for cardiology.';
    const payload = exp.buildExportPayload([pick('H5420-001'), pick('H1036-121')], text, { userMessages: fx.userMessages, catalog });
    const names = payload.doctors.map((d) => d.name);
    assert.ok(!names.some((n) => /fakename|full name/i.test(n)), names.join(', '));
    assert.ok(names.some((n) => /menendez/i.test(n)), 'a doctor she typed is still a row');
  });
});

describe('Gail export: a plan never checked is never Out', () => {
  it('"❌ Out on both: Menendez" right after Rincon does not paint Rincon Out (old H1045-018 cell)', () => {
    const plans = [pick('H1045-018'), pick('H5420-001'), pick('H1036-121'), pick('H1290-085')];
    const docs = exp.extractDoctors(
      'Yes, Dr. Natalia Rincon Buendia (Neurology, NPI 1902300361) is In on Humana — re-checked.\n❌ Out on both: Coren Maria Menendez (PCP).',
      plans
    );
    const rincon = docs.find((d) => /rincon/i.test(d.name));
    assert.ok(rincon);
    assert.ok(!rincon.statuses.includes(exp.NETWORK_OUT), rincon.statuses.join(', '));
  });

  it('a doctor-name line still reads its own status ("Dr. X: H5420-001 IN")', () => {
    const plans = [pick('H5420-001'), pick('H1036-121')];
    const docs = exp.extractDoctors('Dr. Natalia Rincon:\n- H5420-001: In network\n- H1036-121: Out of network', plans);
    assert.deepEqual(docs[0].statuses, [exp.NETWORK_IN, exp.NETWORK_OUT]);
  });
});

describe('Gail export: one row per drug, verified beats Unverified, no "both" row', () => {
  it('Amlodipine/Benazepril + "Amlodipine Besy-Benazepril HCL" are one row with every plan verified', () => {
    const { model, drugRow } = gailExport();
    const amlo = model.drugs.filter((d) => /amlodipine/i.test(d.name));
    assert.equal(amlo.length, 1, amlo.map((d) => d.name).join(' / '));
    assert.equal(amlo[0].name, 'Amlodipine/Benazepril');
    assert.ok(drugRow(/^Amlodipine/).every((c) => c !== 'Unverified'), drugRow(/^Amlodipine/).join(' | '));
  });

  it('"both" (her answer to a question) is never a medication row', () => {
    const { model } = gailExport();
    assert.ok(!model.drugs.some((d) => /^both$/i.test(d.name)));
    assert.equal(exp.isNonDrugName('both'), true);
    assert.equal(exp.isNonDrugName('Repatha'), false);
    assert.deepEqual(R.medsFromAsk('Meds: both'), []);
    assert.deepEqual(R.medsFromAsk('Meds: Xanax, both'), ['Xanax']);
  });

  it('identity key strips salts/strength/form: Besy, HCL, Sodium, mg', () => {
    assert.equal(exp.drugIdentityKey('Amlodipine Besy-Benazepril HCL 10-40mg'), exp.drugIdentityKey('Amlodipine/Benazepril'));
    assert.equal(exp.drugIdentityKey('Levothyroxine Sodium 50 mcg tablet'), exp.drugIdentityKey('Levothyroxine'));
    assert.notEqual(exp.drugIdentityKey('Amlodipine/Valsartan'), exp.drugIdentityKey('Amlodipine/Benazepril'));
    assert.notEqual(exp.drugIdentityKey('Xanax'), exp.drugIdentityKey('Alprazolam'));
  });
});

describe('Gail export: brand not covered reads "Not covered", generic row carries the tier', () => {
  it('Xanax cells say Not covered (not Confirm in Sunfire); Alprazolam (generic) has tiers', () => {
    const { drugRow } = gailExport();
    assert.deepEqual(drugRow(/^Xanax/), ['Not covered', 'Not covered', 'Not covered', 'Not covered']);
    assert.ok(drugRow(/^Alprazolam/).every((c) => /^Tier \d/.test(c)));
  });

  it('server: Xanax is a known brand now, so a not-covered result is not marked unsure', () => {
    const result = {
      drugName: 'Xanax',
      lookups: [{ planId: 'H5420-001', verified: true, coverage: 'not_covered' }],
      byPlanId: { 'H5420-001': { planId: 'H5420-001', verified: true, coverage: 'not_covered' } },
      notCoveredNote: null,
      suggestedGeneric: 'Alprazolam',
    };
    const d = toExportDrug(result);
    assert.equal(d.brandNotCovered, true);
    assert.equal(d.name, 'Xanax*');
    assert.ok(!d.byPlanId['H5420-001'].unsure);
  });
});

describe('formulary catalog: every ingredient of a combination must match', () => {
  const catalogHits = [
    { name: 'Amlodipine Besylate-Valsartan 5-160 MG Oral Tablet' },
    { name: 'Amlodipine Besylate 5 MG Oral Tablet' },
    { name: 'Amlodipine Besylate-Benazepril HCl 5-10 MG Oral Capsule' },
  ];

  it('"Amlodipine Besylate-Benazepril HCl" never resolves to amlodipine/valsartan', () => {
    assert.match(pickCatalogMatch(catalogHits, 'Amlodipine Besylate-Benazepril HCl').name, /benazepril/i);
    assert.match(pickCatalogMatch(catalogHits, 'Amlodipine/Benazepril').name, /benazepril/i);
    assert.equal(pickCatalogMatch(catalogHits.slice(0, 2), 'Amlodipine Besylate-Benazepril HCl'), null);
    assert.equal(pickCatalogMatch(catalogHits, 'Amlodipine').name, 'Amlodipine Besylate 5 MG Oral Tablet');
  });

  it('"Besy" expands for the catalog query; ingredients ignore salts', () => {
    assert.equal(drugCatalogQuery('Amlodipine Besy-Benazepril HCL'), 'Amlodipine Besylate-Benazepril HCL');
    assert.deepEqual(drugIngredients('Amlodipine Besylate-Benazepril HCl 10-40 mg'), ['amlodipine', 'benazepril']);
  });

  it('medicare.gov resolver skips a valsartan autocomplete hit and never falls back to it', async () => {
    const res = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const run = (auto) => resolveMedicareGovNdcs({ drugName: 'Amlodipine Besylate-Benazepril HCl' }, async (url) => {
      const u = String(url);
      if (u.includes('/drugs/autocomplete')) return res({ drugs: auto });
      if (u.includes('/related.json')) return res({ relatedGroup: { conceptGroup: [] } });
      if (u.includes('/rxcui/898346/ndcs.json')) return res({ ndcGroup: { ndcList: { ndc: ['65862058501'] } } });
      if (u.includes('/rxcui/722126/ndcs.json')) return res({ ndcGroup: { ndcList: { ndc: ['00078048915'] } } });
      return res({});
    });
    const val = { rxcui: '722126', name: 'Amlodipine / Valsartan' };
    const ben = { rxcui: '898346', name: 'Amlodipine / Benazepril' };
    const both = await run([val, ben]);
    assert.equal(both.rxcui, '898346');
    assert.deepEqual(both.ndcs, ['65862058501']);
    const onlyWrong = await run([val]);
    assert.equal(onlyWrong.rxcui, null);
    assert.deepEqual(onlyWrong.ndcs, []);
  });
});

describe('numbered answer "both" is not a meds statement', () => {
  it('statements from "2. both" to a meds question add no Meds line', () => {
    const msgs = [
      { role: 'user', content: fx.userMessages[0] },
      { role: 'assistant', content: '1. Does Gail have Medicaid?\n2. Which meds should I price, Xanax or alprazolam?' },
      { role: 'user', content: '1. no 2. both' },
    ];
    const t = N.comparisonAskText(msgs);
    assert.ok(!/Meds:\s*both/i.test(t), t);
  });
});
