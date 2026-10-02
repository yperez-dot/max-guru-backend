const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCE_PDF,
  PBP_REMAP_2027,
  isDoctorsCms,
  matchesPlan,
  remapDoctorsPbp,
  doctorsPbpAliases,
  parseDoctorsFormularyText,
  matchDrugRow,
  lookupDoctorsFormulary,
  resetDoctorsFormularyCache,
} = require('./doctorsFormularyPdf');

const LAYOUT_FIXTURE = `
Drug Name/Nombre del Medicamento                  Tier/Nivel de
                                                     Medicamento
                                                                               Requirements/Limits/
Analgesics/Analgésicos
acetaminophen-codeine oral tablet 300-60 mg                  1        NDS; QL (180 per 30 days)
buprenorphine hcl injection solution 0.3 mg/ml               4        NDS
fentanyl transdermal patch 72 hour 100 mcg/hr,               4        PA; NDS; QL (10 per 30 days)
12 mcg/hr, 25 mcg/hr
ELIQUIS ORAL TABLET 5 MG                                     3        QL (74 per 30 days)
atorvastatin calcium oral tablet 10 mg, 20 mg,               1        QL (30 per 30 days)
40 mg, 80 mg
trimipramine oral capsule 100 mg, 25 mg, 50 mg               4
TRINTELLIX ORAL TABLET 10 MG, 20 MG,                         4        ST; QL (30 per 30 days)
5 MG
vilazodone oral tablet 10 mg, 20 mg, 40 mg                   4        ST; QL (30 per 30 days)
ZURZUVAE ORAL CAPSULE 20 MG, 25 MG                           5        PA - New Starts; NDS; QL (28 per 14
                                                                      days)

I-1
TRINTELLIX......................... 74
`;

const FLOWED_FIXTURE = `
Drug Name/Nombre del Medicamento
Drug
Tier/Nivel de
Medicamento
Requirements/Limits/
TRINTELLIX ORAL TABLET 10 MG, 20 MG,
5 MG
4 ST; QL (30 per 30 days)
ELIQUIS ORAL TABLET 5 MG 3 QL (74 per 30 days)
`;

describe('Doctors 2027 PBP remap', () => {
  it('maps discontinued 001/012 onto 2027 successors and accepts both IDs', () => {
    assert.equal(isDoctorsCms('H4140-001'), true);
    assert.equal(isDoctorsCms('H4140-022'), true);
    assert.equal(isDoctorsCms('H1036-054C'), false);
    assert.equal(matchesPlan('H4140-001', 2027), true);
    assert.equal(matchesPlan('H4140-001', 2026), false);
    assert.equal(matchesPlan('H1036-054C', 2027), false);
    assert.equal(remapDoctorsPbp('H4140-001', 2027), 'H4140-022');
    assert.equal(remapDoctorsPbp('H4140-012', 2027), 'H4140-023');
    assert.equal(remapDoctorsPbp('H4140-022', 2027), 'H4140-022');
    assert.equal(remapDoctorsPbp('H4140-023', 2027), 'H4140-023');
    assert.deepEqual(doctorsPbpAliases('H4140-001', 2027).sort(), ['H4140-001', 'H4140-022']);
    assert.deepEqual(doctorsPbpAliases('H4140-022', 2027).sort(), ['H4140-001', 'H4140-022']);
    assert.deepEqual(doctorsPbpAliases('H4140-012', 2027).sort(), ['H4140-012', 'H4140-023']);
    assert.deepEqual(doctorsPbpAliases('H4140-023', 2027).sort(), ['H4140-012', 'H4140-023']);
    assert.equal(PBP_REMAP_2027['H4140-004'], 'H4140-024');
  });
});

describe('Doctors formulary PDF row parser', () => {
  it('reads layout columns: name, tier, PA/ST/QL — does not invent a missing tier', () => {
    const rows = parseDoctorsFormularyText(LAYOUT_FIXTURE);
    const trin = matchDrugRow(rows, 'Trintellix');
    assert.ok(trin, 'Trintellix row must come from the parsed PDF text');
    assert.equal(trin.tier, 4);
    assert.equal(trin.st, true);
    assert.equal(trin.ql, true);
    assert.equal(trin.pa, false);
    assert.match(trin.name, /TRINTELLIX/i);
    assert.match(trin.name, /5 MG/i);

    const eli = matchDrugRow(rows, 'Eliquis');
    assert.equal(eli.tier, 3);
    assert.equal(eli.ql, true);
    assert.equal(eli.st, false);

    const fent = matchDrugRow(rows, 'fentanyl');
    assert.equal(fent.tier, 4);
    assert.equal(fent.pa, true);

    assert.equal(matchDrugRow(rows, 'not-a-real-drug-xyz'), null);
  });

  it('also parses pypdf-style flowed text (tier on the following line)', () => {
    const rows = parseDoctorsFormularyText(FLOWED_FIXTURE);
    const trin = matchDrugRow(rows, 'trintellix');
    assert.equal(trin.tier, 4);
    assert.equal(trin.st, true);
    assert.equal(trin.ql, true);
  });

  it('skips the index so a dotted page number is not a tier', () => {
    const rows = parseDoctorsFormularyText(LAYOUT_FIXTURE);
    const indexish = rows.filter((r) => /^\s*TRINTELLIX\.+/i.test(r.name));
    assert.equal(indexish.length, 0);
  });
});

function textRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

describe('lookupDoctorsFormulary', () => {
  beforeEach(() => resetDoctorsFormularyCache());

  it('verifies from injected formulary text for 001 and 022', async () => {
    const fetchImpl = async (url) => {
      assert.match(String(url), /2027_FORMULARY\.pdf/);
      return textRes(LAYOUT_FIXTURE);
    };
    const a = await lookupDoctorsFormulary(
      { drugName: 'Trintellix', planId: 'H4140-001', year: 2027 },
      fetchImpl
    );
    const b = await lookupDoctorsFormulary(
      { drugName: 'Trintellix', planId: 'H4140-022', year: 2027 },
      fetchImpl
    );
    assert.equal(a.verified, true);
    assert.equal(a.tier, 4);
    assert.equal(a.st, true);
    assert.equal(a.source, SOURCE_PDF);
    assert.equal(a.formularyPlanId, 'H4140-022');
    assert.equal(b.verified, true);
    assert.equal(b.tier, a.tier);
    assert.equal(b.formularyPlanId, 'H4140-022');
  });

  it('skips non-Doctors plans without fetching', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return textRes(LAYOUT_FIXTURE);
    };
    const hit = await lookupDoctorsFormulary(
      { drugName: 'Trintellix', planId: 'H1036-054C', year: 2027 },
      fetchImpl
    );
    assert.equal(hit.verified, false);
    assert.equal(hit.reason, 'not_doctors');
    assert.equal(calls, 0);
  });
});
