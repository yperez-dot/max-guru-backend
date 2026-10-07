// Katy (krobles), 2026-10-07: pregabalin on Humana Gold Plus H1036-065C 2027 came back "unverified —
// medicare.gov only returned other products" while Plan Compare and Humana show Tier 3 covered.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./formularyLookup');

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

// Live shapes (2026-10-07): most generic NDCs answer with EMPTY drug_costs (not in medicare.gov's
// drug file); only some packages answer. Lyrica brand reads NOT_IN_FORMULARY.
const CONCEPTS = [
  { tty: 'SBD', rxcui: '607022', name: 'pregabalin 200 MG Oral Capsule [Lyrica]', ndcs: ['00071101768'], answer: { '00071101768': 'not' } },
  { tty: 'SCD', rxcui: '483446', name: 'pregabalin 200 MG Oral Capsule', ndcs: ['13668036330', '46708012430', '50228035530', '13668036301', '14445012690', '00904700304', '31722061505'], answer: { '00904700304': 3, '31722061505': 3 } },
  { tty: 'SCD', rxcui: '483438', name: 'pregabalin 25 MG Oral Capsule', ndcs: ['13668036130', '00904700161'], answer: { '00904700161': 3 } },
  { tty: 'SCD', rxcui: '898715', name: 'pregabalin 20 MG/ML Oral Solution', ndcs: ['39328009016'], answer: { '39328009016': 3 } },
  { tty: 'SBD', rxcui: '1994389', name: '24 HR pregabalin 165 MG Extended Release Oral Tablet [Lyrica]', ndcs: ['00071002630'], answer: { '00071002630': 'not' } },
  { tty: 'SCD', rxcui: '596930', name: 'duloxetine 30 MG Delayed Release Oral Capsule', ndcs: ['13811066330', '13668011030'], answer: { '13668011030': 2 } },
  { tty: 'SCD', rxcui: '615186', name: 'duloxetine 40 MG Delayed Release Oral Capsule', ndcs: ['68180029706'], answer: { '68180029706': 'not' } },
];
const AUTO = { pregabalin: { rxcui: '187832', name: 'pregabalin' }, duloxetine: { rxcui: '72625', name: 'duloxetine' } };

function makeFetch() {
  const costCalls = [];
  const answerFor = (ndc) => { for (const c of CONCEPTS) if (ndc in c.answer) return c.answer[ndc]; return undefined; };
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/drugs/autocomplete')) {
      const name = decodeURIComponent(u.split('name=')[1] || '').toLowerCase();
      return jsonRes({ drugs: Object.entries(AUTO).filter(([k]) => name.startsWith(k)).map(([, v]) => v) });
    }
    if (u.includes('/related.json')) {
      const rx = u.match(/rxcui\/(\d+)\/related/)[1];
      const ing = rx === '72625' ? /duloxetine/ : /pregabalin/;
      return jsonRes({ relatedGroup: { conceptGroup: ['SCD', 'SBD'].map((tty) => ({ tty, conceptProperties: CONCEPTS.filter((c) => c.tty === tty && ing.test(c.name)).map((c) => ({ rxcui: c.rxcui, name: c.name })) })) } });
    }
    if (u.includes('/ndcs.json')) {
      const rx = u.match(/rxcui\/(\d+)\/ndcs/)[1];
      const c = CONCEPTS.find((x) => x.rxcui === rx);
      return jsonRes({ ndcGroup: { ndcList: c ? { ndc: c.ndcs } : {} } });
    }
    if (u.includes('/drugs/cost')) {
      const body = JSON.parse(options.body);
      const ndc = body.prescriptions[0].ndc;
      costCalls.push(ndc);
      const a = answerFor(ndc);
      const dc = a === undefined ? [] : a === 'not' ? [{ ndc, covered: false, coverage_reason: 'NOT_IN_FORMULARY', tier: null }] : [{ ndc, covered: true, coverage_reason: 'COVERED', tier: a }];
      const p = body.plans[0];
      return jsonRes({ plans: [{ plan: { contract_id: p.contract_id, plan_id: p.plan_id, contract_year: p.contract_year }, restrictions: [], costs: [{ drug_costs: dc }] }] });
    }
    return jsonRes({ message: 'nope' }, 404);
  };
  return { fetchImpl, costCalls };
}

describe('pregabalin on Humana H1036-065C 2027 (Katy, 2026-10-07)', () => {
  it('pregabalin 200 mg: keeps asking the generic\'s other NDCs past the empty ones → Tier 3, never "only other products"', async () => {
    const { fetchImpl, costCalls } = makeFetch();
    const hit = await F.lookupMedicareGov({ drugName: 'pregabalin 200 MG', planId: 'H1036-065C', year: 2027 }, fetchImpl);
    assert.equal(hit.verified, true);
    assert.equal(hit.coverage, 'covered');
    assert.equal(hit.tier, 3);
    assert.equal(hit.productNote, undefined);
    assert.equal(hit.strengthNote, undefined);
    assert.ok(['00904700304', '31722061505'].includes(hit.ndc), hit.ndc);
    assert.ok(costCalls.includes('13668036330')); // the empty ones were asked first
  });

  it('"pregabalin 20 mg" (strength not matched) confirms at drug level and flags it as unmatched (closest 200 mg)', async () => {
    const { fetchImpl } = makeFetch();
    const hit = await F.lookupMedicareGov({ drugName: 'pregabalin 20 mg', planId: 'H1036-065C', year: 2027 }, fetchImpl);
    assert.equal(hit.verified, true);
    assert.equal(hit.tier, 3);
    assert.equal(hit.strengthNote.asked, '20 mg');
    assert.equal(hit.strengthNote.nearest[0], '200 mg');
    assert.ok(hit.strengthNote.nearest.includes('25 mg'));
    // The 20 MG/ML oral solution is a concentration, not a 20 mg dose.
    assert.notEqual(hit.ndc, '39328009016');
    assert.equal(F.conceptMatchesQuery({ name: 'pregabalin 20 MG/ML Oral Solution' }, 'pregabalin 20 mg'), false);
  });

  it('the strength note reaches the model text', () => {
    const text = F.formatFormularyText({ drugName: 'Pregabalin', year: 2027, lookups: [{ planId: 'H1036-065C', year: 2027, verified: true, tier: 3, coverage: 'covered', costShare: '$5', costShareSource: 'kb_2027', source: 'medicare_gov', strengthNote: { asked: '20 mg', nearest: ['200 mg', '25 mg'], available: [] } }] });
    assert.match(text, /STRENGTH NOT MATCHED: Couldn't match pregabalin 20 mg on medicare\.gov — confirm it\. Closest strengths found: 200 mg, 25 mg\./);
    assert.match(text, /The tier below is drug-level only, not confirmed for 20 mg\./);
    assert.match(text, /H1036-065C: Tier 3 at drug level \(not confirmed for 20 mg\)/);
    assert.match(text, /verified_tier=3 .*tier_scope=drug_level strength=20mg_unmatched_confirm closest=200mg/);
    assert.doesNotMatch(text, /does not exist|not found|verified Tier 3/i);
  });

  it('a real strength never gets the typo flag', () => {
    assert.equal(F.missingStrengthCheck('pregabalin 200 mg', CONCEPTS), null);
    assert.equal(F.missingStrengthCheck('pregabalin', CONCEPTS), null);
  });

  it('duloxetine 30 mg DR: the Sunfire catalog\'s 40 mg NDC is a hint, not the asked product', async () => {
    assert.equal(F.medicareGovQueryName('duloxetine 30 MG Delayed Release Oral Capsule', 'Duloxetine HCL'), 'duloxetine 30 MG Delayed Release Oral Capsule');
    assert.equal(F.medicareGovQueryName('Fesoterodine Fumarate ER', 'Fesoterodine Fumarate ER'), 'Fesoterodine Fumarate ER');
    const { fetchImpl } = makeFetch();
    const hit = await F.lookupMedicareGov({ drugName: 'duloxetine 30 MG Delayed Release Oral Capsule', hintNdc: '68180029706', planId: 'H1036-065C', year: 2027 }, fetchImpl);
    assert.equal(hit.verified, true);
    assert.equal(hit.coverage, 'covered');
    assert.equal(hit.tier, 2);
  });
});
