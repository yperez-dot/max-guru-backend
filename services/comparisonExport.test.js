const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const exp = require('../artifacts/comparison-export.js');
const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');

function loadPlans() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'plan-data block missing');
  return JSON.parse(m[1]);
}

function planById(plans, id, county) {
  return plans.find((p) => (p.planId === id || p.id === id) && (!county || p.county === county));
}

const SAMPLE_THREAD = `
Compare H1045-012 and H1045-061 for Arias Lazo in Miami-Dade.
Plan Terminating: UHC MedicareMax Dual : Partial
Doctors: Dr. Adam Wanner is out of network for both H1045-012 and H1045-061.
Dr. Anila Veerani is in network for both plans.
Dr. Bonny Castro — in-network on H1045-012 and H1045-061.
`;

describe('Arias comparison export labels', () => {
  it('uses sample benefit labels in sample order', () => {
    const labels = exp.FIELD_ROWS.map((row) => row[0]);
    assert.deepEqual(labels, [
      'Premium',
      'Part B Rebate',
      'Referrals Needed?',
      'MSP Levels',
      'Max Out of Pocket',
      'Inpatient Hospital',
      'Outpatient Hospital',
      'PCP',
      'Specialist',
      'ER',
      'Urgent Care',
      'Advanced Imaging (MRI, CT, PET)',
      'Hearing Services',
      'Dental',
      'Deep Cleaning',
      'Dentures',
      'Fillings',
      'Root Canals',
      'Extractions',
      'Crowns',
      'Bridges',
      'Implants',
      'Vision Allowance',
      'Ambulance',
      'Transportation',
      'Companionship',
      'Custodial Care',
      'RX Deductible',
      'Tier 1',
      'Tier 2',
      'Tier 3',
      'Tier 4',
      'Tier 5',
      'Tier 6',
      'OTC',
      'Grocery Card',
      'Acupuncture',
      'Fitness',
    ]);
  });
});

describe('plan column headers', () => {
  it('uses marketing name + contract-PBP, not Carrier — Plan (id) county', () => {
    const header = exp.formatPlanColumnHeader({
      carrier: 'UHC Preferred',
      planName: 'Dual Complete  FL-D001',
      planId: 'H1045-012-000',
      county: 'Miami-Dade',
    });
    assert.match(header, /UHC Preferred Dual Complete\s+FL-D001/);
    assert.match(header, /\nH1045-012$/);
    assert.equal(header.includes('Miami-Dade'), false);
    assert.equal(header.includes('\u2014'), false);
  });

  it('strips duplicated carrier/id from messy grid names', () => {
    const header = exp.formatPlanColumnHeader({
      carrier: 'UHC Preferred Dual Complete FL-V1 HMO D-SNP H1045-061',
      planName: 'UHC Preferred Dual Complete FL-V1 HMO D-SNP H1045-061',
      planId: 'H1045-061',
    });
    assert.match(header, /UHC Preferred Dual Complete FL-V1/);
    assert.match(header, /\nH1045-061$/);
    assert.equal((header.match(/H1045-061/g) || []).length, 1);
  });
});

describe('thread extractors', () => {
  it('pulls client name, terminating plan, and doctor In/Out without inventing', () => {
    const plans = [
      { planId: 'H1045-012', planName: 'Dual Complete' },
      { planId: 'H1045-061', planName: 'Dual Complete FL-V1' },
    ];
    assert.equal(exp.extractClientName(SAMPLE_THREAD), 'Arias Lazo');
    assert.equal(exp.extractTerminatingPlan(SAMPLE_THREAD), 'UHC MedicareMax Dual : Partial');
    const docs = exp.extractDoctors(SAMPLE_THREAD, plans);
    assert.equal(docs.length, 3);
    const byName = Object.fromEntries(docs.map((d) => [d.name, d.statuses]));
    assert.deepEqual(byName['Dr. Adam Wanner'], ['Out of network', 'Out of network']);
    assert.deepEqual(byName['Dr. Anila Veerani'], ['In network', 'In network']);
    assert.deepEqual(byName['Dr. Bonny Castro'], ['In network', 'In network']);
  });

  it('includes named doctors as Not confirmed when network status is unknown', () => {
    const plans = [{ planId: 'H1045-012' }, { planId: 'H1045-061' }];
    const docs = exp.extractDoctors('Client is Arias Lazo. She sees Dr. Adam Wanner and Dr. Anila Veerani.', plans);
    assert.equal(docs.length, 2);
    assert.deepEqual(docs.find((d) => d.name === 'Dr. Adam Wanner').statuses, [
      exp.NETWORK_NOT_CONFIRMED,
      exp.NETWORK_NOT_CONFIRMED,
    ]);
  });

  it('does not invent Plan Terminating unless she says a plan is ending', () => {
    assert.equal(exp.hasExplicitTerminatingLanguage('Compare H1036-054C and H4140-023 for Muskat'), false);
    assert.equal(exp.extractTerminatingPlan('Compare H1036-054C and H4140-023 for Michael Muskat in 33176'), '');
    const plans = [{ planId: 'H1036-054C' }, { planId: 'H4140-023' }];
    const payload = exp.buildExportPayload(plans, 'Compare these for Carol Wong in Miami-Dade.', {
      terminatingPlan: 'should not leak from extras',
      skipMuskatLock: true,
    });
    assert.equal(payload.terminatingPlan, '');
    const model = exp.buildComparisonModel(payload);
    assert.equal(model.aoa.some((row) => row[0] === 'Plan Terminating'), false);
  });

  it('does not invent a client name', () => {
    assert.equal(exp.extractClientName('Compare H1045-012 and H1045-061 in Miami-Dade'), '');
    assert.equal(exp.extractClientName('export this as excel'), '');
    assert.equal(exp.extractClientName('The client is in Miami-Dade'), '');
    assert.equal(exp.extractClientName('Client: Muskat'), 'Muskat');
  });

  it('accepts Yahoska labeled last-name and possessive phrasings', () => {
    assert.equal(exp.extractClientName('Client: Muskat'), 'Muskat');
    assert.equal(exp.extractClientName('Client name: Muskat'), 'Muskat');
    assert.equal(exp.extractClientName("Client's name is Muskat"), 'Muskat');
    assert.equal(exp.extractClientName('Clients name is Muskat'), 'Muskat');
    assert.equal(exp.extractClientName('Client name is Muskat'), 'Muskat');
    assert.equal(exp.extractClientName('Client name is Felix Muskat'), 'Felix Muskat');
    assert.equal(exp.extractClientName('Household: Muskat'), 'Muskat');
    assert.equal(exp.extractClientName('Household name is Muskat'), 'Muskat');
    assert.equal(
      exp.extractClientName('Clients name is Muskat\nCan u check his drs on United?'),
      'Muskat'
    );
  });
});

describe('Arias-like sheet model from live plan-data', () => {
  it('builds title, terminating, doctors, ordered benefits, SOB/EOC', () => {
    const plans = loadPlans();
    const a = planById(plans, 'H1045-012', 'Miami-Dade') || planById(plans, 'H1045-012');
    const b = planById(plans, 'H1045-061', 'Miami-Dade') || planById(plans, 'H1045-061');
    assert.ok(a && b, 'expected H1045-012 and H1045-061 in plan-data');
    assert.equal(a.year, 2027);
    assert.equal(a.premium, '$0');
    assert.equal(String(a.premium).includes('4.8'), false);

    const payload = exp.buildExportPayload([a, b], SAMPLE_THREAD, {});
    const model = exp.buildComparisonModel(payload);

    assert.equal(model.title, 'Arias Lazo');
    assert.equal(model.filenameXlsx.startsWith('Arias_Lazo_Plan_Comparison_'), true);
    assert.match(model.filenamePdf, /\.pdf$/);

    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels[0], 'Arias Lazo');
    assert.equal(labels.includes('Plan Terminating'), true);
    assert.equal(labels.includes('Doctors'), true);
    assert.equal(labels.includes('Dr. Adam Wanner'), true);
    assert.equal(labels.includes('Premium'), true);
    assert.ok(labels.indexOf('Doctors') < labels.indexOf('Premium'), 'doctors before benefits');
    assert.ok(labels.indexOf('Part B Rebate') < labels.indexOf('Referrals Needed?'));
    assert.equal(labels.includes('Chronic Conditions'), false);
    assert.equal(labels.includes('Other'), false);
    assert.equal(labels.includes('MSP Levels'), true, 'D-SNP comparison keeps MSP Levels');
    const msp = model.aoa.find((row) => row[0] === 'MSP Levels');
    assert.ok(msp.slice(1).some((c) => c && c !== 'Not listed'));

    const wanner = model.aoa.find((row) => row[0] === 'Dr. Adam Wanner');
    assert.deepEqual(wanner.slice(1), ['Out of network', 'Out of network']);

    const premium = model.aoa.find((row) => row[0] === 'Premium');
    assert.equal(premium[1], exp.formatBenefitValue(a.premium, 'premium'));
    assert.equal(premium[2], exp.formatBenefitValue(b.premium, 'premium'));
    assert.equal(premium[1], '$0');
    assert.equal(premium[2], exp.formatBenefitValue(b.premium, 'premium'));

    const companionship = model.aoa.find((row) => row[0] === 'Companionship');
    assert.ok(companionship);
    assert.equal(companionship[1], exp.formatBenefitValue(a.companionship, 'companionship'));

    const custodial = model.aoa.find((row) => row[0] === 'Custodial Care');
    assert.deepEqual(custodial.slice(1), ['Not listed', 'Not listed']);

    const sob = model.aoa.find((row) => row[0] === 'Summary of Benefits');
    if (a.sobUrl) {
      assert.equal(sob[1], 'Summary of Benefits');
      assert.ok(model.hyperlinks.some((h) => h.url === a.sobUrl));
    } else {
      assert.equal(sob[1], 'SOB pending');
    }
    const eoc = model.aoa.find((row) => row[0] === 'Evidence of Coverage');
    assert.deepEqual(eoc.slice(1), ['EOC pending', 'EOC pending']);
  });

  it('omits Doctors block when doctors unknown', () => {
    const plans = loadPlans().filter((p) => p.county === 'Miami-Dade').slice(0, 2);
    const model = exp.buildComparisonModel({
      plans,
      clientName: 'Carol Wong',
    });
    assert.equal(model.aoa.some((row) => row[0] === 'Doctors'), false);
  });

  it('formats missing benefits as Not listed and does not turn blank giveback into $0', () => {
    assert.equal(exp.formatBenefitValue(null, 'partBGiveback'), 'Not listed');
    assert.equal(exp.formatBenefitValue('', 'dentalCrowns'), 'Not listed');
    assert.equal(exp.formatBenefitValue('" "', 'dentalDentures'), 'Not listed');
    assert.equal(exp.formatBenefitValue(0, 'partBGiveback'), '$0');
    assert.equal(exp.formatBenefitValue(13, 'partBGiveback'), '$13');
    assert.equal(exp.formatBenefitValue(20, 'specialistCopay'), '$20');
    assert.equal(exp.formatBenefitValue(0.4, 'tier4'), '40%');
  });
});

describe('Rx / Medications rows never copy Daisy tiers', () => {
  const plans = [
    { planId: 'H1036-054C', planName: 'Humana Gold Plus', tier4: 0.4, tier2: 0, tier5: 0.33 },
    { planId: 'H1036-305', planName: 'Humana Gold Plus Giveback', tier4: 0.5, tier2: 0, tier3: 0.09 },
  ];
  const daisy = `
Compare H1036-054C and H1036-305 for Pablo Miriam in Miami-Dade.
Meds from Daisy: Lorazepam T2, Trintellix T4, Atorvastatin Tier 1.
`;

  it('extracts drug names only and discards pasted Daisy tiers', () => {
    const claimed = exp.extractClaimedMeds(daisy);
    const names = claimed.map((d) => d.name);
    assert.ok(names.includes('Lorazepam'));
    assert.ok(names.includes('Trintellix'));
    assert.equal(claimed.every((d) => d.claimedTier == null), true);
    const payload = exp.buildExportPayload(plans, daisy, {});
    const model = exp.buildComparisonModel(payload);
    assert.ok(model.aoa.some((row) => row[0] === 'Medications'));
    const daisyLabels = model.aoa.map((row) => row[0]);
    assert.ok(daisyLabels.indexOf('Medications') < daisyLabels.indexOf('Premium'));
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.ok(trin);
    assert.deepEqual(trin.slice(1), ['Unverified', 'Unverified']);
    assert.equal(trin.includes('Tier 4'), false);
    const lor = model.aoa.find((row) => row[0] === 'Lorazepam');
    assert.deepEqual(lor.slice(1), ['Unverified', 'Unverified']);
    const payloadDrug = payload.drugs.find((d) => d.name === 'Trintellix');
    assert.equal(payloadDrug.claimedTier, undefined);
  });

  it('uses FORMULARY_LOOKUP verified tiers + plan T1–T6 cost-share', () => {
    const thread =
      daisy +
      `
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H1036-054C verified_tier=5 cost_share=33% pa=yes st=no source=sunfire
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H1036-305 verified_tier=3 cost_share=9% source=sunfire
FORMULARY_LOOKUP year=2027 drug=Atorvastatin plan=H1036-054C verified=no reason=unverified
`;
    const payload = exp.buildExportPayload(plans, thread, {});
    const model = exp.buildComparisonModel(payload);
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.match(trin[1], /Tier 5/);
    assert.match(trin[1], /33%/);
    assert.match(trin[2], /Tier 3/);
    const atp = model.aoa.find((row) => row[0] === 'Atorvastatin');
    assert.deepEqual(atp.slice(1), ['Unverified', 'Unverified']);
  });

  it('uses structured extras.drugs lookup tiers and drops claimedTier', () => {
    const payload = exp.buildExportPayload(plans, daisy, {
      drugs: [
        {
          name: 'Trintellix',
          claimedTier: 4,
          byPlanId: {
            'H1036-054C': { verified: true, tier: 5, costShare: '33%', pa: true },
            'H1036-305': { verified: false },
          },
        },
      ],
    });
    const trin = payload.drugs.find((d) => d.name === 'Trintellix');
    assert.equal(trin.claimedTier, undefined);
    assert.equal(trin.byPlanId['H1036-054C'].tier, 5);
    const model = exp.buildComparisonModel(payload);
    const row = model.aoa.find((r) => r[0] === 'Trintellix');
    assert.match(row[1], /Tier 5/);
    assert.equal(row[2], 'Unverified');
    assert.equal(row[1].includes('Tier 4'), false);
  });
});

describe('HTML UI wiring', () => {
  it('inlines the comparison export and offers Excel + PDF', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /MaxComparisonExport/);
    assert.match(html, /exportComparisonToPdf/);
    assert.match(html, /Export PDF/);
    assert.match(html, /jspdf/i);
    assert.match(html, /17b\. EXCEL\/PDF EXPORT|17b\. CLIENT COMPARISON EXPORT/i);
    assert.match(html, /queued-chip/);
    assert.match(html, /20c\. CARRIER GEOGRAPHY 2027/);
    assert.match(html, /MAX_ATTACH_IMAGES/);
    assert.match(html, /collectComparisonExport/);
    assert.match(html, /doctorsFromToolResults/);
    assert.match(html, /drugsFromToolResults/);
    assert.match(html, /Lipitor → Atorvastatin/);
    assert.match(html, /do not wait for the agent to type the generic/);
    assert.match(html, /17c\. MUSKAT 2027 LOCKED COMP/);
    assert.match(html, /Medications immediately under Doctors/);
    assert.match(html, /Omit the MSP Levels row unless at least one compared plan is a D-SNP/);
    assert.match(html, /Do NOT add a Plan Terminating row unless/);
    assert.match(html, /MaxClientWorkups/);
    assert.match(html, /\/workups/);
    assert.match(html, /Save workup/);
    assert.match(html, /Client workups/);
    assert.match(html, /messagesForApi/);
    assert.match(html, /LOADED CLIENT WORKUP/);
    assert.match(html, /loaded-workup-card/);
    assert.match(html, /same list on phone and desktop/);
    assert.match(html, /extractClientName\(threadText\)/);
    assert.match(html, /clientName: extractedName \|\| \(payload && payload.clientName\)/);
    assert.match(html, /max-workup-row/);
    assert.match(html, /max-chat-header/);
    assert.match(html, /@media \(max-width: 640px\)/);
    assert.match(html, /lookup_formulary/);
    assert.match(html, /CLIENT-STATED RX TIERS/);
    assert.match(html, /1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A/);
    assert.match(html, /archive of finished client comps/);
    assert.match(html, /not the 2027 benefit grid/);
  });

  it('keeps the 2027 grid export pointed at the working workbook, not Yahoska archive', () => {
    const common = fs.readFileSync(path.join(__dirname, '../scripts/thei_grid_common.py'), 'utf8');
    const exporter = fs.readFileSync(path.join(__dirname, '../scripts/export_2027_grid_to_kb.py'), 'utf8');
    const syncer = fs.readFileSync(path.join(__dirname, '../scripts/sync_thei_grid_to_max.py'), 'utf8');
    assert.match(common, /1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/);
    assert.match(exporter, /SHEET_ID_2027 as SHEET_ID/);
    assert.match(syncer, /SHEET_ID_2027|1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N/);
    assert.equal(common.includes('1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A'), false);
    assert.equal(exporter.includes('1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A'), false);
    assert.equal(syncer.includes('1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A'), false);
  });

  it('keeps chat compare rule against markdown tables', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /9\. NO MARKDOWN TABLES/);
  });
});

describe('export doctors section + no carrier-as-drug', () => {
  it('keeps a Doctors section from extras / provider-lookup even without thread In/Out prose', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', carrier: 'Humana' },
      { planId: 'H4140-023', planName: 'Doctors DrSelect-SFL', carrier: 'Doctors' },
      { planId: 'H5420-014', planName: 'MedicareMax Complete Care', carrier: 'UHC' },
    ];
    const payload = exp.buildExportPayload(plans, 'Check these providers for Carol Wong.', {
      skipMuskatLock: true,
      doctors: [{ name: 'Dr. Alejandro Roca', statuses: ['Out of network', 'In network', 'In network'] }],
      providerLookups: [
        {
          doctorName: 'Neeta Jane Erinjeri',
          networks: [
            { carrier: 'Humana', inNetwork: true, plans: ['Humana Gold Plus (H1036-054C)'] },
            { carrier: 'Doctors HealthCare Plans', inNetwork: true },
            { carrier: 'UnitedHealthcare', inNetwork: true, plans: ['MedicareMax Complete Care (H5420-014)'] },
          ],
        },
      ],
    });
    const model = exp.buildComparisonModel(payload);
    assert.equal(model.aoa.some((row) => row[0] === 'Doctors'), true);
    const roca = model.aoa.find((row) => row[0] === 'Dr. Alejandro Roca');
    assert.deepEqual(roca.slice(1), ['Out of network', 'In network', 'In network']);
    const neeta = model.aoa.find((row) => /Erinjeri/i.test(row[0]));
    assert.ok(neeta);
    assert.deepEqual(neeta.slice(1), ['In network', 'In network', 'In network']);
    assert.ok(model.aoa.findIndex((row) => row[0] === 'Doctors') < model.aoa.findIndex((row) => row[0] === 'Premium'));
  });

  it('never treats carrier names as medication rows', () => {
    const plans = [
      { planId: 'H1036-054C', carrier: 'Humana', planName: 'Gold Plus' },
      { planId: 'H4140-023', carrier: 'Doctors', planName: 'DrSelect-SFL' },
      { planId: 'H5420-014', carrier: 'UHC', planName: 'MedicareMax Complete Care' },
    ];
    const thread =
      'Compare Doctors, UHC, Humana for Carol Wong. Meds: Doctors T1, UHC T2, Humana Gold Plus T3, Lipitor T4.';
    assert.equal(exp.isCarrierAsDrugName('Doctors'), true);
    assert.equal(exp.isCarrierAsDrugName('UHC'), true);
    assert.equal(exp.isCarrierAsDrugName('Humana'), true);
    assert.equal(exp.looksLikeDrugName('Doctors'), false);
    assert.equal(exp.looksLikeDrugName('Lipitor'), true);
    const claimed = exp.extractClaimedMeds(thread).map((d) => d.name.toLowerCase());
    assert.equal(claimed.includes('doctors'), false);
    assert.equal(claimed.includes('uhc'), false);
    assert.equal(claimed.includes('humana'), false);
    const payload = exp.buildExportPayload(plans, thread, { skipMuskatLock: true });
    const drugNames = payload.drugs.map((d) => d.name.toLowerCase());
    assert.equal(drugNames.includes('doctors'), false);
    assert.equal(drugNames.includes('uhc'), false);
    assert.equal(drugNames.includes('humana'), false);
    const model = exp.buildComparisonModel(payload);
    assert.equal(model.aoa.some((row) => /^doctors$/i.test(row[0])), false);
    assert.equal(model.aoa.some((row) => /^uhc$/i.test(row[0])), false);
    assert.equal(model.aoa.some((row) => /^humana$/i.test(row[0])), false);
  });
});

describe('auto-suggest generic when brand is not covered', () => {
  const plans = [
    { planId: 'H1036-054C', planName: 'Humana Gold Plus', carrier: 'Humana', tier1: 0, county: 'Miami-Dade' },
    { planId: 'H4140-023', planName: 'Doctors DrSelect-SFL', carrier: 'Doctors', tier1: 0, county: 'Miami-Dade' },
    { planId: 'H5420-014', planName: 'MedicareMax Complete Care', carrier: 'UHC', tier1: 0, county: 'Miami-Dade' },
  ];
  const nc = {
    verified: true,
    coverage: 'not_covered',
    tier: null,
    costShare: null,
    source: 'sunfire',
  };

  it('maps Lipitor and Benicar names only', () => {
    assert.equal(exp.knownGenericFor('Lipitor'), 'Atorvastatin');
    assert.equal(exp.knownGenericFor('Benicar*'), 'Olmesartan');
    assert.equal(exp.knownGenericFor('Trintellix'), null);
  });

  it('adds Brand* + generic Unverified from live not_covered without inventing a tier', () => {
    const payload = exp.buildExportPayload(
      plans,
      'Compare H1036-054C, H4140-023, H5420-014 for Carol Wong. Meds: Lipitor T4.',
      {
        skipMuskatLock: true,
        drugs: [
          {
            name: 'Lipitor',
            byPlanId: {
              'H1036-054C': nc,
              'H4140-023': nc,
              'H5420-014': nc,
            },
          },
        ],
      }
    );
    const names = payload.drugs.map((d) => d.name);
    assert.ok(names.includes('Lipitor*'));
    assert.ok(names.includes('Atorvastatin (generic)'));
    const lip = payload.drugs.find((d) => d.name === 'Lipitor*');
    assert.equal(lip.brandNotCovered, true);
    const atv = payload.drugs.find((d) => d.name === 'Atorvastatin (generic)');
    assert.equal(atv.genericOf, 'Lipitor');
    assert.equal(atv.byPlanId['H1036-054C'].verified, false);
    assert.equal(atv.byPlanId['H1036-054C'].tier, null);
    const model = exp.buildComparisonModel(payload);
    assert.ok(model.aoa.some((row) => row[0] === exp.GENERIC_ONLY_NOTE));
    const lipRow = model.aoa.find((row) => row[0] === 'Lipitor*');
    assert.deepEqual(lipRow.slice(1), ['Not covered', 'Not covered', 'Not covered']);
    const atvRow = model.aoa.find((row) => row[0] === 'Atorvastatin (generic)');
    assert.deepEqual(atvRow.slice(1), ['Unverified', 'Unverified', 'Unverified']);
    assert.equal(atvRow.includes('Tier 1'), false);
  });

  it('keeps a live generic tier from lookup extras and never copies Daisy', () => {
    const payload = exp.buildExportPayload(
      plans,
      'Carol Wong meds: Lipitor T4, Benicar T3.',
      {
        skipMuskatLock: true,
        drugs: [
          {
            name: 'Lipitor*',
            brandNotCovered: true,
            byPlanId: { 'H1036-054C': nc, 'H4140-023': nc, 'H5420-014': nc },
          },
          {
            name: 'Atorvastatin (generic)',
            genericOf: 'Lipitor',
            byPlanId: {
              'H1036-054C': { verified: true, tier: 1, coverage: 'covered', costShare: '$0', source: 'sunfire' },
              'H4140-023': { verified: true, tier: 1, coverage: 'covered', costShare: '$0', source: 'sunfire' },
              'H5420-014': { verified: true, tier: 2, coverage: 'covered', costShare: '$0', source: 'sunfire' },
            },
          },
        ],
      }
    );
    const atv = payload.drugs.filter((d) => /atorvastatin/i.test(d.name));
    assert.equal(atv.length, 1);
    const model = exp.buildComparisonModel(payload);
    const atvRow = model.aoa.find((row) => row[0] === 'Atorvastatin (generic)');
    assert.match(atvRow[1], /Tier 1/);
    assert.match(atvRow[1], /\$0/);
    assert.match(atvRow[3], /Tier 2/);
    assert.equal(atvRow[1].includes('Tier 4'), false);
  });

  it('does not mark a Daisy-only brand as not covered or invent a generic tier', () => {
    const payload = exp.buildExportPayload(
      plans,
      'Compare H1036-054C and H4140-023 for Carol Wong. Meds: Lipitor T4, Lorazepam T2.',
      { skipMuskatLock: true }
    );
    const lip = payload.drugs.find((d) => /lipitor/i.test(d.name));
    assert.ok(lip);
    assert.equal(/\*$/.test(lip.name), false);
    assert.equal(lip.brandNotCovered, undefined);
    assert.equal(
      payload.drugs.some((d) => /atorvastatin/i.test(d.name)),
      false
    );
    const model = exp.buildComparisonModel(payload);
    const lipRow = model.aoa.find((row) => /Lipitor/i.test(row[0]));
    assert.deepEqual(lipRow.slice(1), ['Unverified', 'Unverified', 'Unverified']);
  });

  it('pulls the generic from FORMULARY_LOOKUP not_covered lines in the thread', () => {
    const thread = `
Compare H1036-054C and H4140-023 for Carol Wong.
FORMULARY_LOOKUP year=2027 drug=Lipitor plan=H1036-054C verified_tier=none coverage=not_covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Lipitor plan=H4140-023 verified_tier=none coverage=not_covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Atorvastatin plan=H1036-054C verified_tier=1 cost_share=$0 source=sunfire
FORMULARY_LOOKUP year=2027 drug=Atorvastatin plan=H4140-023 verified_tier=1 cost_share=$0 source=sunfire
`;
    const payload = exp.buildExportPayload(plans.slice(0, 2), thread, { skipMuskatLock: true });
    const model = exp.buildComparisonModel(payload);
    const lip = model.aoa.find((row) => row[0] === 'Lipitor*');
    assert.deepEqual(lip.slice(1), ['Not covered', 'Not covered']);
    const atv = model.aoa.find((row) => row[0] === 'Atorvastatin (generic)');
    assert.match(atv[1], /Tier 1/);
    assert.match(atv[2], /Tier 1/);
  });
});

describe('MSP Levels only on dual / D-SNP comparisons', () => {
  it('detects D-SNP and Dual names, not C-SNP or HMO', () => {
    assert.equal(exp.isDualOrDsnpPlan({ type: 'D-SNP', planName: 'Preferred Dual Complete' }), true);
    assert.equal(exp.isDualOrDsnpPlan({ type: 'DSNP' }), true);
    assert.equal(exp.isDualOrDsnpPlan({ type: 'HMO', planName: 'UHC Preferred Dual Complete FL-QV4' }), true);
    assert.equal(exp.isDualOrDsnpPlan({ type: 'HMO', dualLevel: { full: true, partial: false } }), true);
    assert.equal(exp.isDualOrDsnpPlan({ type: 'C-SNP', planName: 'MedicareMax Complete Care FL-30' }), false);
    assert.equal(exp.isDualOrDsnpPlan({ type: 'HMO', planName: 'Humana Gold Plus' }), false);
    assert.equal(
      exp.comparisonIncludesDual([
        { type: 'HMO', planName: 'Gold Plus' },
        { type: 'C-SNP', planName: 'Complete Care' },
      ]),
      false
    );
    assert.equal(
      exp.comparisonIncludesDual([
        { type: 'HMO', planName: 'Gold Plus' },
        { type: 'D-SNP', planName: 'Dual Complete' },
      ]),
      true
    );
  });

  it('omits the MSP Levels row when every compared plan is non-dual', () => {
    const plans = loadPlans();
    const trio = [
      planById(plans, 'H1036-054C', 'Miami-Dade'),
      planById(plans, 'H4140-023', 'Miami-Dade'),
      planById(plans, 'H5420-014', 'Miami-Dade'),
    ].filter(Boolean);
    assert.equal(trio.length, 3);
    const model = exp.buildComparisonModel({
      plans: trio,
      clientName: 'Carol Wong',
      skipMuskatLock: true,
    });
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels.includes('MSP Levels'), false);
    assert.equal(labels.includes('Premium'), true);
    assert.equal(labels.includes('Referrals Needed?'), true);
    assert.equal(labels.includes('Max Out of Pocket'), true);
    assert.ok(labels.indexOf('Referrals Needed?') < labels.indexOf('Max Out of Pocket'));
  });

  it('keeps MSP Levels when at least one compared plan is a D-SNP', () => {
    const plans = loadPlans();
    const dual = planById(plans, 'H1045-012', 'Miami-Dade');
    const hmo = planById(plans, 'H1036-054C', 'Miami-Dade');
    assert.ok(dual && hmo);
    const model = exp.buildComparisonModel({
      plans: [hmo, dual],
      clientName: 'Carol Wong',
    });
    const msp = model.aoa.find((row) => row[0] === 'MSP Levels');
    assert.ok(msp);
    assert.equal(msp[1], 'Not listed');
    assert.notEqual(msp[2], 'Not listed');
  });
});

describe('Muskat 2027 locked export', () => {
  it('locks Michael Muskat columns, doctors, verified Rx, and 2027 green-cell highlights', () => {
    const plans = loadPlans();
    const payload = exp.buildExportPayload(
      [
        planById(plans, 'H1036-305', 'Miami-Dade'),
        planById(plans, 'H4140-012', 'Miami-Dade') || planById(plans, 'H4140-023', 'Miami-Dade'),
        planById(plans, 'H5420-014', 'Miami-Dade'),
      ].filter(Boolean),
      'Excel for Michael Muskat ZIP 33176. Compare Humana, Doctors, and UHC MedicareMax Complete Care.',
      { catalog: plans }
    );
    assert.equal(payload.clientName, 'Michael Muskat');
    assert.equal(payload.terminatingPlan, '');
    assert.deepEqual(
      payload.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-014']
    );
    assert.equal(payload.plans[0].year, 2027);
    assert.equal(payload.plans[0].premium, '$0');
    assert.equal(payload.plans[0].partBGiveback, '$9.30');
    assert.equal(payload.plans[0].moop, '$500');
    assert.equal(payload.plans[1].planId, 'H4140-023');
    assert.equal(payload.plans[1].otc.includes('143'), true);
    assert.equal(payload.plans[2].partBGiveback, '$61');
    assert.match(String(payload.plans[2].otc), /not covered/i);

    const model = exp.buildComparisonModel(payload);
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels[0], 'Michael Muskat');
    assert.equal(labels.includes('Plan Terminating'), false);
    assert.ok(labels.indexOf('Doctors') < labels.indexOf('Medications'));
    assert.ok(labels.indexOf('Medications') < labels.indexOf('Premium'));
    assert.ok(labels.indexOf('Memantine') < labels.indexOf('Premium'));
    assert.ok(labels.indexOf('Fitness') < labels.indexOf('Summary of Benefits'));
    assert.ok(labels.includes(exp.GENERIC_ONLY_NOTE));
    assert.equal(labels.includes('MSP Levels'), false, 'non-dual Muskat comp omits MSP Levels');

    const roca = model.aoa.find((row) => row[0] === 'Dr. Alejandro Roca');
    assert.deepEqual(roca.slice(1), ['Out of network', 'In network', 'In network']);
    const kaiser = model.aoa.find((row) => row[0] === 'Dr. Charles J. Kaiser');
    assert.deepEqual(kaiser.slice(1), ['Out of network', 'In network', 'In network']);
    const trattler = model.aoa.find((row) => row[0] === 'Dr. William Trattler');
    assert.deepEqual(trattler.slice(1), ['Out of network', 'In network', 'In network']);
    const neeta = model.aoa.find((row) => row[0] === 'Dr. Neeta Jane Erinjeri');
    assert.deepEqual(neeta.slice(1), ['In network', 'In network', 'In network']);

    const lipitor = model.aoa.find((row) => row[0] === 'Lipitor*');
    assert.deepEqual(lipitor.slice(1), ['Not covered', 'Not covered', 'Not covered']);
    const atv = model.aoa.find((row) => row[0] === 'Atorvastatin (generic)');
    assert.ok(atv.slice(1).every((c) => /Tier 1/.test(c) && /\$0/.test(c)));
    const benicar = model.aoa.find((row) => row[0] === 'Benicar*');
    assert.deepEqual(benicar.slice(1), ['Not covered', 'Not covered', 'Not covered']);
    const olm = model.aoa.find((row) => row[0] === 'Olmesartan (generic)');
    assert.ok(olm.slice(1).every((c) => /Tier 1/.test(c) && /\$0/.test(c)));
    const lor = model.aoa.find((row) => row[0] === 'Lorazepam');
    assert.match(lor[1], /Tier 4/);
    assert.match(lor[1], /40%/);
    assert.match(lor[2], /Tier 1/);
    assert.match(lor[3], /Tier 2/);
    const gab = model.aoa.find((row) => row[0] === 'Gabapentin');
    assert.match(gab[1], /Tier 2/);
    assert.match(gab[2], /Tier 1/);
    assert.match(gab[3], /Tier 2/);
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.match(trin[1], /Tier 4/);
    assert.match(trin[1], /40%/);
    assert.match(trin[2], /Tier 4/);
    assert.match(trin[2], /\$55/);
    assert.match(trin[3], /Tier 3/);
    const mem = model.aoa.find((row) => row[0] === 'Memantine');
    assert.ok(mem.slice(1).every((c) => /Tier 2/.test(c) && /\$0/.test(c)));

    const prem = model.aoa.find((row) => row[0] === 'Premium');
    assert.equal(prem[1], '$0');
    const give = model.aoa.find((row) => row[0] === 'Part B Rebate');
    assert.equal(give[1], '$9.30');
    assert.equal(give[2], 'No');
    assert.equal(give[3], '$61');
  });
});
