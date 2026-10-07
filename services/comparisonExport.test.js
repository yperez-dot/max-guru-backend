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
    const junk =
      'Do not add a Plan Terminating row. H5420-001 is HMO, not dual — no MSP row';
    assert.equal(exp.hasExplicitTerminatingLanguage(junk), false);
    assert.equal(exp.extractTerminatingPlan(junk), '');
    assert.equal(
      exp.extractTerminatingPlan(
        'no Plan Terminating row. H5420-001 is HMO, not dual — no MSP row'
      ),
      ''
    );
    const plans = [{ planId: 'H1036-054C' }, { planId: 'H4140-023' }];
    const payload = exp.buildExportPayload(plans, junk, {
      terminatingPlan: 'should not leak from extras',
      clientName: 'Michael Muskat',
    });
    assert.equal(payload.terminatingPlan, '');
    const model = exp.buildComparisonModel(payload);
    assert.equal(model.aoa.some((row) => row[0] === 'Plan Terminating'), false);
  });

  it('a chat/MSP sentence does not create a Plan Terminating row', () => {
    const liveChat = `
Excel for Michael Muskat ZIP 33176.
Compare Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, stay-put UHC MedicareMax FL-0028 H5420-001.
Do NOT add a Plan Terminating row unless the agent explicitly says a current plan is terminating.
H5420-001 is HMO, not dual — no MSP row.
Never invent a Plan Terminating row from "no MSP row."
`;
    assert.equal(exp.hasExplicitTerminatingLanguage(liveChat), false);
    assert.equal(exp.extractTerminatingPlan(liveChat), '');
    assert.equal(
      exp.sanitizeTerminatingPlan('row. H5420-001 is HMO, not dual — no MSP row', liveChat),
      ''
    );
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', type: 'HMO' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', type: 'HMO' },
      { planId: 'H5420-001', planName: 'MedicareMax FL-0028', type: 'HMO' },
    ];
    const payload = exp.buildExportPayload(plans, liveChat, { clientName: 'Michael Muskat' });
    assert.equal(payload.terminatingPlan, '');
    const fromOffer = exp.buildComparisonModel({
      plans,
      clientName: 'Michael Muskat',
      terminatingPlan: 'row. H5420-001 is HMO, not dual — no MSP row',
      threadText: liveChat,
    });
    assert.equal(fromOffer.aoa.some((row) => row[0] === 'Plan Terminating'), false);
    assert.equal(fromOffer.aoa.some((row) => String(row[1] || '').includes('no MSP row')), false);
    const fromPayload = exp.buildComparisonModel(payload);
    assert.equal(fromPayload.aoa.some((row) => row[0] === 'Plan Terminating'), false);
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

describe('H4140-023 DrSelect SoB URL on live plan-data', () => {
  const DRSELECT = 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf';
  const DRMAX = 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf';

  it('exports Summary of Benefits as the 2027 DrSelect PDF, not Dr Max', () => {
    const plans = loadPlans();
    const dade = planById(plans, 'H4140-023', 'Miami-Dade');
    const broward = planById(plans, 'H4140-023', 'Broward');
    const max = planById(plans, 'H4140-022', 'Miami-Dade');
    assert.equal(dade.sobUrl, DRSELECT);
    assert.equal(broward.sobUrl, DRSELECT);
    assert.equal(max.sobUrl, DRMAX);

    const model = exp.buildComparisonModel({ plans: [dade] });
    const sob = model.aoa.find((row) => row[0] === 'Summary of Benefits');
    assert.equal(sob[1], 'Summary of Benefits');
    assert.ok(model.hyperlinks.some((h) => h.url === DRSELECT));
    assert.equal(model.hyperlinks.some((h) => h.url === DRMAX), false);
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
    assert.match(html, /17c\. MUSKAT 2027/);
    assert.match(html, /CURRENT comparison in this thread/);
    assert.match(html, /sameExportPlanSet/);
    assert.match(html, /H5420-001/);
    assert.match(html, /\\d\{2,4\}\[A-Z\]\?/);
    assert.match(html, /keepCurrentComparisonPlans/);
    assert.match(html, /lastUserComparisonAsk/);
    assert.match(html, /Do not lock the export to this snapshot/);
    assert.match(html, /dedupeComparisonPlans/);
    assert.match(html, /uniquePlansByContractPbp/);
    assert.match(html, /compactContractPbp/);
    assert.match(html, /Medications immediately under Doctors/);
    assert.match(html, /Omit the MSP Levels row unless at least one compared plan is a D-SNP/);
    assert.match(html, /lookup_sob_benefit/);
    assert.match(html, /sobFromToolResults/);
    assert.match(html, /fillExportSobBenefits/);
    assert.match(html, /askedExportSobBenefits/);
    assert.match(html, /askedOffGridBenefits/);
    assert.match(html, /hydrateExportSobBenefits/);
    assert.match(html, /runComparisonExport/);
    assert.match(html, /Do NOT look up SNF or hospital-grade bed/);
    assert.match(html, /Do NOT add a Plan Terminating row unless/);
    assert.match(html, /MaxClientWorkups/);
    assert.match(html, /\/workups/);
    assert.equal(html.includes('Save workup'), false);
    assert.equal(html.includes('Update workup'), false);
    assert.equal(html.includes('data-testid="save-workup"'), false);
    assert.equal(html.includes('currentWorkupId ? "Update" : "Save"'), false);
    assert.match(html, /Export Excel/);
    assert.match(html, /Export PDF/);
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
    assert.match(html, /runComparisonExport\("excel", messagesRef\.current, m\.plans/);
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

describe('SOB-only extra benefit rows', () => {
  it('omits SNF / DME rows when she did not ask for those benefits', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', inpatientHospital: '$0', hearing: '$0 exam' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', inpatientHospital: '$0', hearing: '$1,350' },
      { planId: 'H5420-001', planName: 'MedicareMax FL-0028', inpatientHospital: '$0', hearing: '$0 exam' },
    ];
    const model = exp.buildComparisonModel({
      plans,
      clientName: 'Mr. and Mrs. Muskat',
      threadText: 'Compare H1036-054C, H4140-023, and H5420-001 for Mr. and Mrs. Muskat.',
      skipMuskatLock: true,
    });
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels.includes('Skilled Nursing Facility (days 1–20)'), false);
    assert.equal(labels.includes('Skilled Nursing Facility (days 21–100)'), false);
    assert.equal(labels.includes('Hospital-grade bed / DME'), false);
    assert.equal(labels.includes('Hearing Aids'), false);
    assert.equal(labels.includes('Plan Terminating'), false);
  });

  it('still prints the three SOB rows when she asked and the chat never stored a lookup', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', inpatientHospital: '$0', hearing: '$0 exam' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', inpatientHospital: '$0', hearing: '$1,350' },
      { planId: 'H5420-001', planName: 'MedicareMax FL-0028', inpatientHospital: '$0', hearing: '$0 exam' },
    ];
    const payload = exp.buildExportPayload(
      plans,
      'Mr. and Mrs. Muskat need SNF days 1-20, SNF days 21-100, and a hospital-grade bed.',
      { skipMuskatLock: true }
    );
    assert.equal(payload.askedExportSob, true);
    const model = exp.buildComparisonModel(payload);
    const labels = model.aoa.map((row) => row[0]);
    assert.ok(labels.includes('Skilled Nursing Facility (days 1–20)'));
    assert.ok(labels.includes('Skilled Nursing Facility (days 21–100)'));
    assert.ok(labels.includes('DME'));
    assert.equal(labels.includes('Hearing Aids'), false);
    assert.equal(labels.includes('Plan Terminating'), false);
    const snf1 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 1–20)');
    const snf2 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 21–100)');
    const dme = model.aoa.find((row) => row[0] === 'DME');
    assert.deepEqual(snf1.slice(1), ['Unverified', 'Unverified', 'Unverified']);
    assert.deepEqual(snf2.slice(1), ['Unverified', 'Unverified', 'Unverified']);
    assert.deepEqual(dme.slice(1), ['Unverified', 'Unverified', 'Unverified']);
    assert.equal(model.aoa.some((row) => /scription|cal DME|\u2026|\.\.\.$/.test(row.join(' '))), false);
  });

  it('omits hearing-aids rows when the SOB did not find them', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', inpatientHospital: '$0', hearing: '$0 exam' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', inpatientHospital: '$0', hearing: '$1,350' },
    ];
    const model = exp.buildComparisonModel({
      plans,
      clientName: 'Pablo Miriam',
      skipMuskatLock: true,
    });
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels.includes('Hearing Aids'), false);
  });

  it('fillExportSobBenefits looks up the three rows when she asked and chat stored nothing', async () => {
    const plans = [
      {
        planId: 'H1036-054C',
        planName: 'Humana Gold Plus',
        sobUrl: 'https://example.com/humana.pdf',
        inpatientHospital: '$0',
      },
      {
        planId: 'H4140-023',
        planName: 'DrSelect-SFL',
        sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf',
        inpatientHospital: '$0',
      },
      {
        planId: 'H5420-001',
        planName: 'MedicareMax FL-0028',
        sobUrl: 'https://example.com/uhc.pdf',
        inpatientHospital: '$0',
      },
    ];
    let called = null;
    const skipped = await exp.fillExportSobBenefits(plans, {}, async () => {
      throw new Error('should not look up when she did not ask');
    });
    assert.deepEqual(skipped, {});
    const filled = await exp.fillExportSobBenefits(
      plans,
      {},
      async (req) => {
        called = req;
        return {
          sobBenefits: {
            'H1036-054C': {
              snfDays1to20: { value: 'Days 1-20: $0 copay', source: 'sob' },
              snfDays21to100: { value: 'Days 21-100: $214 copay per day', source: 'sob' },
              dmeHospitalBed: { value: 'Hospital bed 20% coinsurance', source: 'sob' },
            },
            'H4140-023': {},
            'H5420-001': {
              snfDays1to20: { value: 'Days 1-20: $0 copay', source: 'sob' },
            },
          },
        };
      },
      { asked: true, threadText: 'Need SNF days 1-20 and a hospital-grade bed.' }
    );
    assert.ok(called);
    assert.deepEqual(called.benefits, ['skilled_nursing', 'dme']);
    assert.deepEqual(called.planIds, ['H1036-054C', 'H4140-023', 'H5420-001']);
    const model = exp.buildComparisonModel({
      plans,
      clientName: 'Mr. and Mrs. Muskat',
      sobBenefits: filled,
      skipMuskatLock: true,
    });
    const snf1 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 1–20)');
    const snf2 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 21–100)');
    const dme = model.aoa.find((row) => row[0] === 'DME');
    assert.equal(snf1[1], 'Days 1-20: $0 copay');
    assert.equal(snf1[2], 'Unverified');
    assert.equal(snf1[3], 'Days 1-20: $0 copay');
    assert.match(snf2[1], /\$214/);
    assert.equal(snf2[2], 'Unverified');
    assert.equal(dme[1], 'Hospital bed 20% coinsurance');
    assert.equal(dme[2], 'Unverified');
    assert.equal(dme.includes('$999'), false);
    assert.equal(model.aoa.some((row) => row[0] === 'Plan Terminating'), false);
  });

  it('prints an asked off-grid benefit that is not SNF or DME, and leaves grid rows alone', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', premium: '$0', inpatientHospital: '$0' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', premium: '$0', inpatientHospital: '$0' },
    ];
    const asked = exp.askedOffGridBenefits(
      'Compare H1036-054C and H4140-023. What is the copay for chemotherapy?'
    );
    assert.equal(asked.asked, true);
    assert.ok(asked.benefits.includes('chemotherapy'));
    assert.equal(
      exp.askedOffGridBenefits('Compare H1036-054C and H4140-023 for Mr. and Mrs. Muskat.').asked,
      false
    );
    const skipped = exp.buildComparisonModel({
      plans,
      threadText: 'Compare H1036-054C and H4140-023 for Mr. and Mrs. Muskat.',
      skipMuskatLock: true,
    });
    const skippedLabels = skipped.aoa.map((row) => row[0]);
    assert.equal(skippedLabels.includes('Chemotherapy'), false);
    assert.ok(skippedLabels.includes('Premium'));
    assert.ok(skippedLabels.includes('Inpatient Hospital'));
    const model = exp.buildComparisonModel({
      plans,
      threadText: 'Compare H1036-054C and H4140-023. Need chemotherapy.',
      skipMuskatLock: true,
    });
    const labels = model.aoa.map((row) => row[0]);
    assert.ok(labels.includes('Chemotherapy'));
    assert.ok(labels.includes('Premium'));
    assert.equal(labels.includes('Skilled Nursing Facility (days 1–20)'), false);
    const chemo = model.aoa.find((row) => row[0] === 'Chemotherapy');
    assert.deepEqual(chemo.slice(1), ['Unverified', 'Unverified']);
    assert.equal(model.aoa.find((row) => row[0] === 'Premium')[1], '$0');
  });

  it('fillExportSobBenefits looks up the asked off-grid benefit, not every extra', async () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', sobUrl: 'https://example.com/humana.pdf' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', sobUrl: 'https://example.com/doctors.pdf' },
    ];
    let called = null;
    const filled = await exp.fillExportSobBenefits(
      plans,
      {},
      async (req) => {
        called = req;
        return {
          sobBenefits: {
            'H1036-054C': { chemotherapy: { value: 'Chemotherapy $35 copay', source: 'sob' } },
          },
        };
      },
      { threadText: 'Need chemotherapy on H1036-054C and H4140-023.' }
    );
    assert.ok(called);
    assert.deepEqual(called.benefits, ['chemotherapy']);
    assert.match(called.query, /chemotherapy/i);
    const model = exp.buildComparisonModel({
      plans,
      threadText: 'Need chemotherapy on H1036-054C and H4140-023.',
      sobBenefits: filled,
      skipMuskatLock: true,
    });
    const chemo = model.aoa.find((row) => row[0] === 'Chemotherapy');
    assert.equal(chemo[1], 'Chemotherapy $35 copay');
    assert.equal(chemo[2], 'Unverified');
    assert.equal(model.aoa.some((row) => row[0] === 'Hospital-grade bed / DME'), false);
  });

  it('adds SNF, hearing aids, and DME rows only from live SOB/grid extras — no invented dollars', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus', inpatientHospital: '$0', hearing: '$0 exam · $199 Level 1' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL', inpatientHospital: '$0', hearing: '$1,350 every 2 years' },
    ];
    const payload = exp.buildExportPayload(plans, 'Pablo and Miriam need SNF, hearing aids, and a hospital-grade bed.', {
      skipMuskatLock: true,
      sobBenefits: {
        'H1036-054C': {
          snfDays1to20: { value: 'Days 1-20: $0 copay', source: 'sob' },
          snfDays21to100: { value: 'Days 21-100: $214 copay per day', source: 'sob' },
          hearingAids: { value: '$199 Level 1 / $475 Level 2 per ear', source: 'sob' },
          dmeHospitalBed: { value: 'Hospital bed 20% coinsurance', source: 'sob' },
        },
      },
    });
    const model = exp.buildComparisonModel(payload);
    const labels = model.aoa.map((row) => row[0]);
    assert.ok(labels.indexOf('Inpatient Hospital') < labels.indexOf('Skilled Nursing Facility (days 1–20)'));
    assert.ok(labels.indexOf('Skilled Nursing Facility (days 21–100)') < labels.indexOf('Outpatient Hospital'));
    assert.ok(labels.indexOf('Hearing Services') < labels.indexOf('Hearing Aids'));
    const snf1 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 1–20)');
    assert.equal(snf1[1], 'Days 1-20: $0 copay');
    assert.equal(snf1[2], 'Unverified');
    const snf2 = model.aoa.find((row) => row[0] === 'Skilled Nursing Facility (days 21–100)');
    assert.match(snf2[1], /\$214/);
    const aids = model.aoa.find((row) => row[0] === 'Hearing Aids');
    assert.match(aids[1], /\$199/);
    const dme = model.aoa.find((row) => row[0] === 'DME');
    assert.match(dme[1], /20%/);
    assert.equal(dme.includes('$999'), false);
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
    assert.equal(payload.clientName, 'Mr. and Mrs. Muskat');
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
    assert.equal(labels[0], 'Mr. and Mrs. Muskat');
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

  it('uses the current Muskat thread (H5420-001 stay-put), not the old 014 snapshot', () => {
    const plans = loadPlans();
    const trio = [
      planById(plans, 'H1036-054C', 'Miami-Dade'),
      planById(plans, 'H4140-023', 'Miami-Dade'),
      planById(plans, 'H5420-001', 'Miami-Dade'),
    ].filter(Boolean);
    assert.equal(trio.length, 3);
    const thread = `
Excel for Michael Muskat ZIP 33176.
Compare Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, and stay-put UHC MedicareMax FL-0028 H5420-001.
H5420-001 is HMO, not dual — no MSP row.
Do not add a Plan Terminating row.
Doctors: Dr. Alejandro Roca, Dr. Charles J. Kaiser, Dr. William Trattler, Dr. Neeta Jane Erinjeri,
Dr. Jason Margolesky, Miami Neurology & Rehab.
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H5420-001 verified_tier=3 cost_share=$25 coverage=covered source=sunfire
`;
    const payload = exp.buildExportPayload(trio, thread, {
      catalog: plans,
      doctors: exp.muskatLockedDoctors(),
      drugs: exp.muskatLockedDrugs(),
    });
    assert.deepEqual(
      payload.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    assert.equal(payload.terminatingPlan, '');
    assert.equal(exp.currentPlansMatchMuskatLock(payload.plans), false);
    assert.equal(payload.plans[2].partBGiveback, '$50');
    assert.equal(payload.plans[2].moop, '$3,900');
    assert.match(String(payload.plans[2].inpatientHospital), /\$95/);
    assert.equal(payload.plans[2].specialistCopay, '$15');
    assert.equal(payload.plans[2].urgentCareCopay, '$25');
    assert.match(String(payload.plans[2].otc), /\$25/);

    const names = payload.doctors.map((d) => d.name);
    assert.ok(names.some((n) => /Margolesky/i.test(n)));
    assert.ok(names.some((n) => /Miami Neurology/i.test(n)));
    assert.ok(names.some((n) => /Roca/i.test(n)));

    const model = exp.buildComparisonModel(payload);
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels.includes('Plan Terminating'), false);
    assert.ok(labels.some((l) => /Margolesky/i.test(l)));
    assert.ok(labels.some((l) => /Miami Neurology/i.test(l)));
    const give = model.aoa.find((row) => row[0] === 'Part B Rebate');
    assert.equal(give[3], '$50');
    assert.notEqual(give[3], '$61');
    const moop = model.aoa.find((row) => row[0] === 'Max Out of Pocket');
    assert.equal(moop[3], '$3,900');
    const inp = model.aoa.find((row) => row[0] === 'Inpatient Hospital');
    assert.match(inp[3], /\$95/);
    const spec = model.aoa.find((row) => row[0] === 'Specialist');
    assert.equal(spec[3], '$15');
    const uc = model.aoa.find((row) => row[0] === 'Urgent Care');
    assert.equal(uc[3], '$25');
    const otc = model.aoa.find((row) => row[0] === 'OTC');
    assert.match(otc[3], /\$25/);
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.match(trin[3], /Tier 3/);
    assert.match(trin[3], /\$25/);
    assert.equal(/\$0/.test(trin[3]), false);
  });

  it('keeps Humana H1036-054C first when the latest cite is only 023 + 001', () => {
    const plans = loadPlans();
    const humana = planById(plans, 'H1036-054C', 'Miami-Dade');
    const doctors = planById(plans, 'H4140-023', 'Miami-Dade');
    const uhc = planById(plans, 'H5420-001', 'Miami-Dade');
    assert.ok(humana && doctors && uhc);
    const ids = exp.citedPlanIdsFromText(
      'Michael Muskat: Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, stay-put UHC MedicareMax FL-0028 H5420-001'
    );
    assert.ok(ids.includes('H1036-054C'));
    const kept = exp.keepCurrentComparisonPlans([doctors, uhc], [humana, doctors, uhc]);
    assert.deepEqual(
      kept.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    const thread = `
Excel for Michael Muskat.
Current comparison: Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, UHC MedicareMax FL-0028 H5420-001.
Latest reply only restated H4140-023 and H5420-001.
Doctors: Dr. Alejandro Roca, Dr. Jason Margolesky, Miami Neurology & Rehab.
MARGOLESKY, JASON is in network on H4140-023 and H5420-001.
`;
    const payload = exp.buildExportPayload([doctors, uhc], thread, { catalog: plans });
    assert.deepEqual(
      payload.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    const model = exp.buildComparisonModel(payload);
    const header = model.aoa[1] || model.aoa.find((row) => /H1036-054C/.test(row.join(' ')));
    assert.ok(header && header.some((c) => /H1036-054C/.test(String(c))));
  });

  it('a new message after a saved workup updates Excel instead of locking the old sheet', () => {
    const plans = loadPlans();
    const saved = [
      planById(plans, 'H1036-054C', 'Miami-Dade'),
      planById(plans, 'H4140-023', 'Miami-Dade'),
      planById(plans, 'H5420-001', 'Miami-Dade'),
    ].filter(Boolean);
    assert.equal(saved.length, 3);
    const chemoAsk = 'Need chemotherapy on these plans.';
    const chemo = exp.buildExportPayload(saved, chemoAsk, {
      catalog: plans,
      latestUserText: chemoAsk,
      rememberedPlans: saved,
      skipMuskatLock: true,
    });
    assert.deepEqual(
      chemo.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    assert.equal(chemo.askedExportSob, true);
    const chemoModel = exp.buildComparisonModel(chemo);
    assert.ok(chemoModel.aoa.some((row) => row[0] === 'Chemotherapy'));
    assert.ok(chemoModel.aoa.some((row) => row[0] === 'Premium'));
    assert.equal(chemoModel.aoa.some((row) => row[0] === 'Plan Terminating'), false);

    const newCompare = 'Compare H4140-023 and H5420-001 only.';
    const switched = exp.buildExportPayload(saved, newCompare, {
      catalog: plans,
      latestUserText: newCompare,
      rememberedPlans: saved,
      skipMuskatLock: true,
    });
    assert.deepEqual(
      switched.plans.map((p) => exp.displayContractPbp(p)),
      ['H4140-023', 'H5420-001']
    );
    assert.equal(switched.plans.some((p) => exp.displayContractPbp(p) === 'H1036-054C'), false);

    const history = [
      { role: 'workup', content: 'saved Muskat sheet' },
      { role: 'offer', content: 'export', plans: saved },
      { role: 'user', content: newCompare },
      { role: 'user', content: 'Export Excel' },
    ];
    const lastAsk = exp.lastUserComparisonAsk(history);
    assert.match(lastAsk, /H4140-023/);
    assert.equal(exp.isExportOnlyAsk('Export Excel'), true);
    assert.equal(exp.requestUpdatesComparison(chemoAsk), true);
  });

  it('collapses duplicate 023/001 columns and keeps verified Muskat Rx', () => {
    const plans = loadPlans();
    const humana = planById(plans, 'H1036-054C', 'Miami-Dade');
    const doctors = planById(plans, 'H4140-023', 'Miami-Dade');
    const doctorsBroward = planById(plans, 'H4140-023', 'Broward') || Object.assign({}, doctors, { county: 'Broward' });
    const uhc = planById(plans, 'H5420-001', 'Miami-Dade');
    const uhcSlash = Object.assign({}, uhc, { planId: 'H5420-001/0028', id: 'H5420-001/0028' });
    const duped = [humana, doctors, doctorsBroward, uhc, uhcSlash].filter(Boolean);
    assert.ok(duped.length >= 5);
    const collapsed = exp.dedupeComparisonPlans(duped);
    assert.deepEqual(
      collapsed.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    const thread = `
Excel for Michael Muskat. Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, UHC MedicareMax FL-0028 H5420-001/0028.
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H5420-001 verified_tier=3 cost_share=$25 coverage=covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Lorazepam plan=H1036-054C verified_tier=4 cost_share=40% coverage=covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Gabapentin plan=H4140-023 verified_tier=1 cost_share=$0 coverage=covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Memantine plan=H5420-001 verified_tier=2 cost_share=$0 coverage=covered source=sunfire
`;
    const payload = exp.buildExportPayload(duped, thread, {
      catalog: plans,
      drugs: exp.muskatLockedDrugs(),
    });
    assert.deepEqual(
      payload.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    const model = exp.buildComparisonModel(payload);
    const headers = model.aoa.find((row) => row.some((c) => /H1036-054C/.test(String(c))));
    assert.equal(headers.filter((c) => /H4140-023/.test(String(c))).length, 1);
    assert.equal(headers.filter((c) => /H5420-001/.test(String(c))).length, 1);
    const names = model.aoa.map((row) => row[0]);
    assert.ok(names.includes('Lipitor*'));
    assert.ok(names.includes('Atorvastatin (generic)'));
    assert.ok(names.includes('Benicar*'));
    assert.ok(names.includes('Olmesartan (generic)'));
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.match(trin[3], /Tier 3/);
    assert.match(trin[3], /\$25/);
    assert.equal(trin.slice(1).some((c) => c === 'Unverified'), false);
    const lor = model.aoa.find((row) => row[0] === 'Lorazepam');
    assert.match(lor[1], /Tier 4/);
    const gab = model.aoa.find((row) => row[0] === 'Gabapentin');
    assert.match(gab[2], /Tier 1/);
    const mem = model.aoa.find((row) => row[0] === 'Memantine');
    assert.match(mem[3], /Tier 2/);
  });

  it('collapses an 8-column live payload to one column per contract-PBP and keeps doctors + Rx', () => {
    const plans = loadPlans();
    const humana = planById(plans, 'H1036-054C', 'Miami-Dade');
    const doctorsDade = planById(plans, 'H4140-023', 'Miami-Dade');
    const doctorsBroward = planById(plans, 'H4140-023', 'Broward') || Object.assign({}, doctorsDade, { county: 'Broward' });
    const uhc = planById(plans, 'H5420-001', 'Miami-Dade');
    const eight = [
      humana,
      Object.assign({}, humana, { id: 'H1036-054C-000-2027', planId: 'H1036-054C-000-2027' }),
      doctorsDade,
      doctorsBroward,
      Object.assign({}, doctorsDade, { planId: 'H4140-023-000', id: 'H4140-023-000' }),
      uhc,
      Object.assign({}, uhc, { planId: 'H5420-001/0028', id: 'H5420-001/0028' }),
      Object.assign({}, uhc, { planId: 'H5420-001-000-2027', id: 'H5420-001-000-2027' }),
    ].filter(Boolean);
    assert.equal(eight.length, 8);
    assert.equal(exp.compactContractPbp('H5420-001/0028'), 'H5420-001');
    assert.equal(exp.compactContractPbp('H4140-023-000-2027'), 'H4140-023');
    assert.equal(exp.compactContractPbp('H1036-054C-000-2027'), 'H1036-054C');
    const thread = `
Excel for Michael Muskat ZIP 33176.
Compare Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, stay-put UHC MedicareMax FL-0028 H5420-001.
Doctors: Dr. Alejandro Roca, Dr. Jason Margolesky, Miami Neurology & Rehab.
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H5420-001 verified_tier=3 cost_share=$25 coverage=covered source=sunfire
FORMULARY_LOOKUP year=2027 drug=Lorazepam plan=H1036-054C verified_tier=4 cost_share=40% coverage=covered source=sunfire
`;
    const payload = exp.buildExportPayload(eight, thread, {
      catalog: plans,
      drugs: exp.muskatLockedDrugs(),
      doctors: exp.muskatLockedDoctors(),
    });
    assert.deepEqual(
      payload.plans.map((p) => exp.displayContractPbp(p)),
      ['H1036-054C', 'H4140-023', 'H5420-001']
    );
    const offer = { role: 'offer', content: 'export', plans: eight, doctors: payload.doctors, drugs: payload.drugs, clientName: 'Michael Muskat', threadText: thread };
    const model = exp.buildComparisonModel(offer);
    const ids = model.payload.plans.map((p) => exp.displayContractPbp(p));
    assert.deepEqual(ids, ['H1036-054C', 'H4140-023', 'H5420-001']);
    const labels = model.aoa.map((row) => row[0]);
    assert.ok(labels.indexOf('Doctors') < labels.indexOf('Medications'));
    assert.ok(labels.some((l) => /Roca/i.test(l)));
    assert.ok(labels.includes('Lipitor*'));
    assert.ok(labels.includes('Atorvastatin (generic)'));
    const trin = model.aoa.find((row) => row[0] === 'Trintellix');
    assert.match(trin[3], /Tier 3/);
    assert.match(trin[3], /\$25/);
    assert.equal(trin.slice(1).every((c) => c !== 'Unverified'), true);
  });

  it('dedupes legal-name and short-name doctor rows and keeps Margolesky + Miami Neurology', () => {
    const plans = [
      { planId: 'H1036-054C', planName: 'Humana Gold Plus' },
      { planId: 'H4140-023', planName: 'DrSelect-SFL' },
      { planId: 'H5420-001', planName: 'MedicareMax FL-0028' },
    ];
    const merged = exp.mergeDoctorLists(
      [
        [
          { name: 'MARGOLESKY, JASON', statuses: ['Not confirmed', 'In network', 'In network'] },
          {
            name: 'MIAMI NEUROLOGY & REHABILITATION SPECIALISTS',
            statuses: ['Not confirmed', 'In network', 'In network'],
          },
        ],
        [
          { name: 'Dr. Jason Margolesky', statuses: ['Not confirmed', 'Not confirmed', 'Not confirmed'] },
          { name: 'Miami Neurology & Rehab', statuses: ['Not confirmed', 'Not confirmed', 'Not confirmed'] },
          { name: 'Dr. Alejandro Roca', statuses: ['Out of network', 'In network', 'In network'] },
        ],
      ],
      plans
    );
    const keys = merged.map((d) => exp.doctorIdentityKey(d.name));
    assert.equal(keys.filter((k) => k === 'person:margolesky:j').length, 1);
    assert.equal(keys.filter((k) => k === 'clinic:miami-neurology-rehab').length, 1);
    const jason = merged.find((d) => /margolesky/i.test(d.name));
    assert.ok(jason);
    assert.deepEqual(jason.statuses, ['Not confirmed', 'In network', 'In network']);
    assert.match(jason.name, /Jason Margolesky/i);
    const clinic = merged.find((d) => /neurology/i.test(d.name));
    assert.ok(clinic);
    assert.deepEqual(clinic.statuses, ['Not confirmed', 'In network', 'In network']);
    assert.equal(merged.filter((d) => /margolesky/i.test(d.name)).length, 1);
    assert.equal(merged.filter((d) => /neurology/i.test(d.name)).length, 1);
    const model = exp.buildComparisonModel({
      plans,
      clientName: 'Michael Muskat',
      doctors: merged,
      skipMuskatLock: true,
    });
    const labels = model.aoa.map((row) => row[0]);
    assert.equal(labels.filter((l) => /margolesky/i.test(l)).length, 1);
    assert.equal(labels.filter((l) => /neurology/i.test(l)).length, 1);
  });
});

describe('One column per distinct contract-PBP (follow-up hardening)', () => {
  const ids = (list) => list.map((p) => exp.displayContractPbp(p));
  const clone = (p, o) => Object.assign({}, p, o);
  function trio() {
    const plans = loadPlans();
    return {
      plans,
      h: planById(plans, 'H1036-054C', 'Miami-Dade'),
      d: planById(plans, 'H4140-023', 'Miami-Dade'),
      u: planById(plans, 'H5420-001', 'Miami-Dade'),
      u14: planById(plans, 'H5420-014', 'Miami-Dade'),
      giveback: planById(plans, 'H1036-305', 'Miami-Dade'),
    };
  }

  it('keeps H5420-001 and H5420-014 as two columns when both are in the comparison', () => {
    const { h, d, u, u14 } = trio();
    assert.ok(h && d && u && u14);
    const model = exp.buildComparisonModel({ plans: [u14, d, u, h], clientName: 'Test Client' });
    assert.deepEqual(ids(model.payload.plans), ['H1036-054C', 'H4140-023', 'H5420-001', 'H5420-014']);
    assert.deepEqual(ids(exp.dedupeComparisonPlans([h, d, u, u14])), ['H1036-054C', 'H4140-023', 'H5420-001', 'H5420-014']);
  });

  it('does not cap distinct plans (4+ columns) and only drops a second copy of the same ID', () => {
    const { h, d, u, giveback } = trio();
    assert.ok(giveback);
    const five = [h, clone(h), d, clone(d, { county: 'Broward' }), u, clone(u, { planId: 'H5420-001/0028', id: 'H5420-001/0028' }), giveback];
    assert.deepEqual(ids(exp.uniquePlansByContractPbp(five)), ['H1036-054C', 'H4140-023', 'H5420-001', 'H1036-305']);
  });

  it('keeps THEI compound IDs intact (no mangling) while still collapsing real copies', () => {
    assert.equal(exp.displayContractPbp({ planId: 'H5471-077-00' }), 'H5471-077-00');
    assert.equal(exp.displayContractPbp({ planId: 'H5420-003 FL-0029' }), 'H5420-003FL-0029');
    assert.notEqual(exp.displayContractPbp({ planId: 'H5420-003 FL-0029' }), 'H5420-003F');
    assert.equal(exp.displayContractPbp({ planId: 'H1036-054C-000-2027' }), 'H1036-054C');
    assert.equal(exp.compactContractPbp('H5471-077-00'), 'H5471-077-00');
    assert.notEqual(exp.compactContractPbp('H5471-077-00'), exp.compactContractPbp('H5471-077'));
    assert.equal(exp.compactContractPbp('H5420-001/0028'), 'H5420-001');
    assert.equal(exp.compactContractPbp('H4140-023-000'), 'H4140-023');
    assert.equal(exp.compactContractPbp('H1036-054'), 'H1036-054C');
    const a = { planId: 'H5471-077-00', planName: 'A' };
    const b = { planId: 'H5420-003 FL-0029', planName: 'B' };
    assert.equal(exp.uniquePlansByContractPbp([a, clone(a), b]).length, 2);
  });

  it('realigns positional doctor statuses when stacked plan copies collapse', () => {
    const { h, d, u } = trio();
    const eight = [h, clone(h), d, clone(d, { county: 'Broward' }), clone(d), u, clone(u, { planId: 'H5420-001/0028', id: 'H5420-001/0028' }), clone(u)];
    // Truth by contract-PBP: Humana OUT, Doctors IN, UHC IN (copies repeat their column's status)
    const statuses = [
      'Out of network', 'Out of network',
      'In network', 'In network', 'In network',
      'In network', 'In network', 'In network',
    ];
    const model = exp.buildComparisonModel({ plans: eight, clientName: 'Test Client', doctors: [{ name: 'Dr. Test', statuses }] });
    assert.deepEqual(ids(model.payload.plans), ['H1036-054C', 'H4140-023', 'H5420-001']);
    const row = model.aoa.find((r) => r[0] === 'Dr. Test');
    assert.deepEqual(row.slice(1), ['Out of network', 'In network', 'In network']);
  });

  it('prefers a real In/Out over a Not confirmed copy when folding duplicate columns', () => {
    const { h, d, u } = trio();
    const stacked = [h, d, clone(d), u];
    const statuses = ['In network', 'Not confirmed', 'Out of network', 'In network'];
    const model = exp.buildComparisonModel({ plans: stacked, clientName: 'Test Client', doctors: [{ name: 'Dr. Fold', statuses }] });
    const row = model.aoa.find((r) => r[0] === 'Dr. Fold');
    assert.deepEqual(row.slice(1), ['In network', 'Out of network', 'In network']);
  });

  it('keepCurrentComparisonPlans: a cited 001 replaces a stale remembered 014', () => {
    const { h, d, u, u14 } = trio();
    assert.deepEqual(ids(exp.keepCurrentComparisonPlans([h, d, u], [h, d, u14])), ['H1036-054C', 'H4140-023', 'H5420-001']);
    assert.deepEqual(ids(exp.keepCurrentComparisonPlans([d, u], [h, d, u14])), ['H1036-054C', 'H4140-023', 'H5420-001']);
  });

  it('keepCurrentComparisonPlans: 001 and 014 both cited now stay as two columns', () => {
    const { h, d, u, u14 } = trio();
    assert.deepEqual(ids(exp.keepCurrentComparisonPlans([u, u14], [h, d, u14])), ['H1036-054C', 'H4140-023', 'H5420-001', 'H5420-014']);
  });

  it('a 014 formulary lookup never fills a separate 001 column', () => {
    const { u, u14 } = trio();
    const live = { verified: true, tier: 3, costShare: '$0', coverage: 'covered', source: 'sunfire' };
    const rows = exp.normalizeDrugs([{ name: 'Trintellix', byPlanId: { 'H5420-014': live } }], [u, u14]);
    assert.equal(rows[0].byPlanId['H5420-014'].verified, true);
    assert.equal(rows[0].byPlanId['H5420-001'].verified, false);
    // ...but with only a 001 column, the old alias fallback still maps it there.
    const only001 = exp.normalizeDrugs([{ name: 'Trintellix', byPlanId: { 'H5420-014': live } }], [u]);
    assert.equal(only001[0].byPlanId['H5420-001'].verified, true);
  });

  it('Muskat stay-put export from a stacked 8-column offer keeps Doctors, Rx, and no Plan Terminating', () => {
    const { plans, h, d, u } = trio();
    const eight = [h, clone(h), d, clone(d, { county: 'Broward' }), clone(d), u, clone(u, { planId: 'H5420-001/0028', id: 'H5420-001/0028' }), clone(u)];
    const thread = `
Excel for Michael Muskat ZIP 33176.
Compare Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, stay-put UHC MedicareMax FL-0028 H5420-001.
FORMULARY_LOOKUP year=2027 drug=Trintellix plan=H5420-001 verified_tier=3 cost_share=$25 coverage=covered source=sunfire
`;
    const payload = exp.buildExportPayload(eight, thread, { catalog: plans, rememberedPlans: eight });
    const model = exp.buildComparisonModel(payload);
    assert.deepEqual(ids(model.payload.plans), ['H1036-054C', 'H4140-023', 'H5420-001']);
    const labels = model.aoa.map((r) => r[0]);
    assert.equal(labels.includes('Plan Terminating'), false);
    assert.ok(labels.indexOf('Doctors') < labels.indexOf('Medications'));
    assert.ok(labels.indexOf('Medications') < labels.indexOf('Premium'));
    const lip = model.aoa.find((r) => r[0] === 'Lipitor*');
    assert.deepEqual(lip.slice(1), ['Not covered', 'Not covered', 'Not covered']);
    const atv = model.aoa.find((r) => r[0] === 'Atorvastatin (generic)');
    assert.ok(atv.slice(1).every((c) => /Tier 1/.test(c) && /\$0/.test(c)));
    const trin = model.aoa.find((r) => r[0] === 'Trintellix');
    assert.match(trin[3], /Tier 3/);
    assert.match(trin[3], /\$25/);
  });
});

describe('UHC verified In network stays on H5420-001', () => {
  const uhcPlans = [
    { planId: 'H1036-054C', planName: 'Humana Gold Plus', carrier: 'Humana', type: 'HMO' },
    { planId: 'H4140-023', planName: 'Doctors DrSelect-SFL', carrier: 'Doctors', type: 'HMO' },
    { planId: 'H5420-001', planName: 'MedicareMax FL-0028', carrier: 'UHC', type: 'HMO' },
  ];
  const slashyUhc = { planId: 'H5420-001/0028', id: 'H5420-001/0028', planName: 'MedicareMax FL-0028', carrier: 'UHC', type: 'HMO' };

  it('keeps a verified UHC In network doctor In network instead of Not confirmed', () => {
    const priorIn = [
      {
        name: 'Dr. WILLIAM B TRATTLER MD',
        byPlanId: {
          'H1036-054C': 'Out of network',
          'H4140-023': 'In network',
          'H5420-001': 'In network',
        },
        statuses: ['Out of network', 'In network', 'In network'],
      },
      {
        name: 'Dr. ALEJANDRO OCTAVIO ROCA M.D.',
        byPlanId: {
          'H1036-054C': 'Out of network',
          'H4140-023': 'In network',
          'H5420-001': 'In network',
        },
      },
      {
        name: 'Dr. CHARLES JOSIAH KAISER M.D.',
        byPlanId: {
          'H1036-054C': 'Out of network',
          'H4140-023': 'In network',
          'H5420-001': 'In network',
        },
      },
      {
        name: 'Dr. NEETA JANE ERINJERI M.D.',
        byPlanId: {
          'H1036-054C': 'In network',
          'H4140-023': 'In network',
          'H5420-001': 'In network',
        },
      },
    ];
    const missLookups = priorIn.map((d) => ({
      doctorName: d.name,
      networks: [
        { carrier: 'Humana', inNetwork: false, plans: [], outOfNetworkPlans: ['Humana Gold Plus (H1036-054C)'], status: 'checked' },
        { carrier: 'Doctors HealthCare Plans', inNetwork: true },
        { carrier: 'UnitedHealthcare', inNetwork: false, plans: [], outOfNetworkPlans: [], status: 'checked', error: null },
      ],
    }));
    const thread = `
Excel for Michael Muskat. Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, UHC MedicareMax FL-0028 H5420-001.
Do not add a Plan Terminating row. H5420-001 is HMO, not dual — no MSP row.
Dr. WILLIAM B TRATTLER MD, Dr. ALEJANDRO OCTAVIO ROCA M.D., Dr. CHARLES JOSIAH KAISER M.D., Dr. NEETA JANE ERINJERI M.D.
Earlier: all four In network on UHC H5420-001.
`;
    const payload = exp.buildExportPayload(uhcPlans, thread, {
      skipMuskatLock: true,
      doctors: priorIn,
      providerLookups: missLookups,
    });
    const model = exp.buildComparisonModel(payload);
    const trattler = model.aoa.find((row) => /trattler/i.test(row[0]));
    const roca = model.aoa.find((row) => /roca/i.test(row[0]));
    const kaiser = model.aoa.find((row) => /kaiser/i.test(row[0]));
    const erinjeri = model.aoa.find((row) => /erinjeri/i.test(row[0]));
    assert.deepEqual(trattler.slice(1), ['Out of network', 'In network', 'In network']);
    assert.deepEqual(roca.slice(1), ['Out of network', 'In network', 'In network']);
    assert.deepEqual(kaiser.slice(1), ['Out of network', 'In network', 'In network']);
    assert.deepEqual(erinjeri.slice(1), ['In network', 'In network', 'In network']);
    assert.equal(trattler.includes('Not confirmed'), false);
  });

  it('attaches UHC In network to H5420-001 even when the column was stored as H5420-001/0028', () => {
    const lookups = [
      {
        doctorName: 'WILLIAM B TRATTLER MD',
        networks: [
          { carrier: 'Humana', inNetwork: false, outOfNetworkPlans: ['Humana Gold Plus (H1036-054C)'] },
          { carrier: 'Doctors HealthCare Plans', inNetwork: true },
          { carrier: 'UnitedHealthcare', inNetwork: true, plans: ['UHC MedicareMax FL-0028 (H5420-001)'], status: 'in_network' },
        ],
      },
    ];
    const fromSlashy = exp.doctorsFromProviderLookups(lookups, [uhcPlans[0], uhcPlans[1], slashyUhc]);
    const trattler = fromSlashy.find((d) => /trattler/i.test(d.name));
    assert.ok(trattler);
    assert.equal(trattler.statuses[2], exp.NETWORK_IN);
    const offer = {
      plans: uhcPlans,
      clientName: 'Carol Wong',
      skipMuskatLock: true,
      doctors: [
        {
          name: 'Dr. WILLIAM B TRATTLER MD',
          statuses: ['Out of network', 'In network', 'Not confirmed'],
          byPlanId: { 'H1036-054C': 'Out of network', 'H4140-023': 'In network', 'H5420-001': 'In network' },
        },
      ],
    };
    const model = exp.buildComparisonModel(offer);
    const row = model.aoa.find((r) => /trattler/i.test(r[0]));
    assert.deepEqual(row.slice(1), ['Out of network', 'In network', 'In network']);
  });

  describe('SOB rows, dental counts, session tool results', () => {
    it('formats Doctors dental counts as "N covered", not dollars', () => {
      assert.equal(exp.formatBenefitValue(2, 'dentalFillings'), '2 covered');
      assert.equal(exp.formatBenefitValue('4', 'dentalExtractions'), '4 covered');
      assert.equal(exp.formatBenefitValue(0, 'dentalBridges'), 'Not covered');
      assert.equal(exp.formatBenefitValue(13, 'partBGiveback'), '$13');
    });

    it('mergeToolResults accumulates and caps', () => {
      const a = [{ tool: 'a' }];
      const b = [{ tool: 'b' }, null, 'x'];
      assert.deepEqual(exp.mergeToolResults(a, b).map((t) => t.tool), ['a', 'b']);
      const many = Array.from({ length: 10 }, (_, i) => ({ tool: 't' + i }));
      const capped = exp.mergeToolResults([], many, 4);
      assert.equal(capped.length, 4);
      assert.equal(capped[3].tool, 't9');
    });

    it('exports DrSelect DME without inventing a hospital-bed dollar', () => {
      const doctors = planById(loadPlans(), 'H4140-023', 'Miami-Dade');
      assert.equal(
        doctors.sobUrl,
        'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf'
      );
      const model = exp.buildComparisonModel({
        plans: [doctors],
        clientName: 'Carol Wong',
        sobBenefits: {
          'H4140-023': {
            dme: {
              value:
                '0% coinsurance for covered items including CPAP and all other medical equipment; 20% coinsurance for powered wheelchairs, powered mattress systems, and other electric devices',
              source: 'sob',
            },
          },
        },
      });
      const row = (label) => model.aoa.find((r) => r[0] === label);
      assert.match(row('DME')[1], /0%/);
      assert.match(row('DME')[1], /20%/);
      assert.doesNotMatch(row('DME')[1], /hospital/i);
      assert.equal(row('Hospital-grade bed / DME'), undefined);
    });

    it('prints SNF and DME rows when sobBenefits carries values', () => {
      const plans = loadPlans().filter((p) => p.county === 'Miami-Dade').slice(0, 2);
      const id0 = exp.displayContractPbp(plans[0]);
      const model = exp.buildComparisonModel({
        plans,
        clientName: 'Carol Wong',
        sobBenefits: {
          [id0]: {
            snfDays1to20: { value: '$0 copay' },
            snfDays21to100: { value: '$203/day' },
            dmeHospitalBed: { value: '20% coinsurance' },
          },
        },
      });
      const row = (label) => model.aoa.find((r) => r[0] === label);
      assert.equal(row('Skilled Nursing Facility (days 1–20)')[1], '$0 copay');
      assert.equal(row('Skilled Nursing Facility (days 21–100)')[1], '$203/day');
      assert.equal(row('DME')[1], '20% coinsurance');
      assert.equal(row('DME')[2], 'Unverified');
    });

    it('UI keeps session-wide tool results and passes SOB data to Excel/PDF', () => {
      const html = fs.readFileSync(HTML_PATH, 'utf8');
      assert.match(html, /sessionToolResultsRef\s*=\s*useRef/);
      assert.match(html, /MaxComparisonExport\.mergeToolResults\(sessionToolResultsRef\.current/);
      assert.match(html, /sobBenefits: payload\.sobBenefits/);
      assert.match(html, /sobBenefits: m\.sobBenefits \|\| \{\}/);
      assert.match(html, /toolResults: sessionToolResultsRef\.current/);
    });

    it('drops scraped PDF fragments instead of printing them', () => {
      const plans = loadPlans().filter((p) => p.county === 'Miami-Dade').slice(0, 2);
      const id0 = exp.displayContractPbp(plans[0]);
      const id1 = exp.displayContractPbp(plans[1]);
      const model = exp.buildComparisonModel({
        plans,
        clientName: 'Carol Wong',
        sobBenefits: {
          [id0]: {
            hearingAids: { value: 'scription hearing · aid up to 1 per ear per year. · • $475 copay…' },
            dmeHospitalBed: { value: 'cal DME (e.g., $0 copay · equipment (DME) wheelchairs, ·…' },
            snfDays1to20: { value: 'days 1-20: $60 copay' },
          },
          [id1]: { dmeHospitalBed: { value: '$0 copay' } },
        },
      });
      const row = (label) => model.aoa.find((r) => r[0] === label);
      assert.equal(row('DME')[1], 'Unverified');
      assert.equal(row('DME')[2], '$0 copay');
      assert.equal(row('Skilled Nursing Facility (days 1–20)')[1], 'days 1-20: $60 copay');
      const hearing = row('Hearing Aids');
      assert.ok(!hearing || hearing[1] === 'Unverified' || !/scription/.test(hearing[1]));
    });

    it('Muskat export always lists Margolesky and Miami Neurology (Not confirmed without a lookup)', () => {
      const catalog = loadPlans();
      const pick = (id) => catalog.find((p) => exp.displayContractPbp(p) === id);
      const plans = ['H1036-054C', 'H4140-023', 'H5420-001'].map(pick).filter(Boolean);
      assert.equal(plans.length, 3);
      const model = exp.buildComparisonModel(exp.buildExportPayload(plans, 'Michael Muskat comparison', { catalog }));
      const mar = model.aoa.find((r) => /margolesky/i.test(r[0] || ''));
      const neu = model.aoa.find((r) => /miami neurology/i.test(r[0] || ''));
      assert.ok(mar && neu);
      assert.deepEqual(mar.slice(1), ['Not confirmed', 'Not confirmed', 'Not confirmed']);
    });
  });

  describe('clinic lookup misses vs explicit Out of network', () => {
    const doctorsPlans = () => loadPlans().filter((p) => /doctors/i.test(p.carrier || p.planName || '')).slice(0, 1);
    const miss = (name) => ({
      doctorName: name,
      networks: [{ carrier: 'Doctors HealthCare Plans', inNetwork: false, status: 'ok' }],
    });

    it('a directory miss is Not confirmed for clinics and people alike (same as the chat table — never assume Out)', () => {
      const plans = doctorsPlans();
      assert.equal(plans.length, 1);
      const docs = exp.doctorsFromProviderLookups(
        [miss('Miami Neurology & Rehab'), miss('Jason Margolesky')],
        plans
      );
      const clinic = docs.find((d) => /miami neurology/i.test(d.name));
      const person = docs.find((d) => /margolesky/i.test(d.name));
      assert.equal(clinic.statuses[0], 'Not confirmed');
      assert.equal(person.statuses[0], 'Not confirmed');
    });

    it('Doctors DrMax-Dade / Devoted: a finished directory miss for a person is Out (matches chat table); failed/pending stays Not confirmed', () => {
      const plans = loadPlans().filter((p) => /^H4140-022|^H1290-001/.test(String(p.planId || p.id || '').toUpperCase()));
      assert.equal(plans.length, 2);
      const lookup = (name, status) => ({ doctorName: name, networks: [
        { carrier: 'Doctors HealthCare Plans', inNetwork: false, status },
        { carrier: 'Devoted Health', inNetwork: false, status },
      ] });
      const [checked, failed, pending] = ['checked', 'failed', 'pending'].map((st, i) => exp.doctorsFromProviderLookups([lookup(`Dileep Yavagal${i}`, st)], plans)[0]);
      assert.deepEqual(checked.statuses, ['Out of network', 'Out of network']);
      assert.ok(failed.statuses.every((x) => x !== 'Out of network'));
      assert.ok(pending.statuses.every((x) => x !== 'Out of network'));
      const clinic = exp.doctorsFromProviderLookups([lookup('Miami Neurology & Rehab', 'checked')], plans)[0];
      assert.ok(clinic.statuses.every((x) => x !== 'Out of network'));
    });

    it('Solis: a name-index listing is In; a checked miss is Out; no check stays Not confirmed', () => {
      const plans = loadPlans().filter((p) => /^H0982-016/.test(String(p.planId || p.id || '').toUpperCase()));
      assert.equal(plans.length, 1);
      const run = (inNetwork, status) => exp.doctorsFromProviderLookups([{ doctorName: 'Eduardo Krajewski', networks: [{ carrier: 'Solis Health Plans', inNetwork, status }] }], plans)[0].statuses[0];
      assert.notEqual(run(true, 'checked'), 'Out of network');
      assert.equal(run(false, 'checked'), 'Out of network');
      assert.notEqual(run(false, 'failed'), 'Out of network');
    });

    it('a clinic the agent says is out of network stays Out of network', () => {
      const plans = doctorsPlans();
      const id = exp.displayContractPbp(plans[0]);
      const payload = exp.buildExportPayload(plans, 'Carol Wong comparison', {
        catalog: loadPlans(),
        doctors: [{ name: 'Miami Neurology & Rehab', byPlanId: { [id]: 'Out of network' } }],
      });
      const clinic = payload.doctors.find((d) => /miami neurology/i.test(d.name));
      assert.equal(clinic.statuses[0], 'Out of network');
    });

    it('a clinic the carrier lists as out of network stays Out of network', () => {
      const plans = doctorsPlans();
      const id = exp.displayContractPbp(plans[0]);
      const docs = exp.doctorsFromProviderLookups(
        [{ doctorName: 'Miami Neurology & Rehab', networks: [{ carrier: 'Doctors HealthCare Plans', inNetwork: false, outOfNetworkPlans: [id] }] }],
        plans
      );
      assert.equal(docs[0].statuses[0], 'Out of network');
    });
  });
});

describe('narrowing replies are not a finished comparison', () => {
  it('flags the Padron candidates + questions reply', () => {
    const reply = 'No one plan has all eight. Counts only — not a ranking:\n- AARP Medicare Advantage from UHC FL-0031 (R0759-001) — 6/8 in\n- UHC Preferred Medicare Advantage FL-0002 (H1045-005) — 5/8 in\n- Humana Gold Plus (H1036-065C) — 4/8 in\n1. Do they have Medicaid or an MSP (QMB/SLMB)? Yes, full / Yes, MSP only / No\n2. Which doctors are must-keep?\n3. HMO OK, or do they need a PPO?\nOnce I have those, I\u2019ll pull 2\u20133 plans that actually fit.';
    assert.equal(exp.isNarrowingReply(reply), true);
  });
  it('does not flag a final 2–3 plan answer', () => {
    assert.equal(exp.isNarrowingReply('Here are 2 plans that fit: Humana Gold Plus (H1036-065C) and UHC Preferred MA (H1045-005). Ernesto Padron In on both.'), false);
  });
});

describe('Padron export cleanup', () => {
  const plans = [
    { planId: 'H5420-014', carrier: 'UHC', planName: 'MedicareMax Complete Care FL-30' },
    { planId: 'R0759-001', carrier: 'UHC', planName: 'AARP Regional PPO FL-0031' },
    { planId: 'H1045-005', carrier: 'UHC', planName: 'Preferred MA FL-0002' },
    { planId: 'H1036-065C', carrier: 'Humana', planName: 'Gold Plus' },
  ];
  const text = 'Maria & Gaspar Padron, ZIP 33332. Current plan H5420-014 terminating 2027. No Medicaid. Skip R0759-001 (non-commissionable).';

  it('keeps the terminating and skipped plans out of the columns', () => {
    const p = exp.buildExportPayload(plans, text, {});
    assert.deepEqual(p.plans.map((x) => x.planId), ['H1045-005', 'H1036-065C']);
    assert.equal(p.terminatingPlan, 'H5420-014');
  });

  it('shows clean doctor names', () => {
    assert.equal(exp.cleanProviderDisplayName('ERNESTO PADRON M.D'), 'Dr. Ernesto Padron');
    assert.equal(exp.cleanProviderDisplayName('EYE SURGERY ASSOCIATES LLC'), 'Eye Surgery Associates');
  });
});

describe('unverified not-covered in the Excel', () => {
  it('shows "Confirm in Sunfire", never a flat "Not covered", when Max could not verify', () => {
    const f = require('./formularyLookup');
    const d = f.toExportDrug({ drugName: 'Levothyroxine Sodium', notCoveredNote: 'x', byPlanId: { 'H1036-065C': { verified: true, coverage: 'not_covered' } }, lookups: [] });
    const p = exp.buildExportPayload([{ planId: 'H1036-065C', carrier: 'Humana', planName: 'Gold Plus' }, { planId: 'H1045-005', carrier: 'UHC', planName: 'Preferred MA' }], 'Compare H1036-065C, H1045-005', { drugs: [d] });
    assert.equal(exp.formatDrugCell(p.drugs[0].byPlanId['H1036-065C'], p.plans[0]), 'Confirm in Sunfire');
    assert.equal(exp.formatDrugCell({ verified: true, coverage: 'not_covered' }, p.plans[0]), 'Not covered');
  });
});

describe('export matches the chat table (2026-10-06 Doctors/Solis/Devoted export)', () => {
  const plan = (planId, carrier, planName) => ({ planId, id: planId, carrier, planName, county: 'Miami-Dade' });
  const humana054 = plan('H1036-054C', 'Humana', 'Humana Gold Plus');
  const humana305 = plan('H1036-305', 'Humana', 'Humana Gold Plus Giveback');
  const drMax = plan('H4140-022', 'Doctors', 'Doctors DrMax-Dade');
  const drCsnp = plan('H4140-024', 'Doctors', 'Doctors DrExtraCare');
  const devoted = plan('H1290-001', 'Devoted', 'Devoted CORE 001');

  it('In for one Humana plan is not In for every Humana plan', () => {
    const docs = exp.doctorsFromProviderLookups([{ doctorName: 'EDUARDO KRAJEWSKI', networks: [{ carrier: 'Humana Find Care', inNetwork: true, plans: ['Humana Gold Plus Giveback (H1036-305)'] }] }], [humana054, humana305]);
    assert.deepEqual(docs[0].statuses, ['Not confirmed', 'In network']);
  });

  it('a Doctors directory hit is In for DrMax-Dade only, Devoted for every plan', () => {
    const docs = exp.doctorsFromProviderLookups([{ doctorName: 'JUAN DIEGO CEDENO', networks: [
      { carrier: 'Doctors HealthCare Plans', inNetwork: true, plans: [] },
      { carrier: 'Devoted Health', inNetwork: true },
    ] }], [drMax, drCsnp, devoted]);
    assert.deepEqual(docs[0].statuses, ['In network', 'Not confirmed', 'In network']);
  });

  it('"Krajewski" and "Eduardo Krajewski" are one row; In vs Out becomes Need more info', () => {
    const merged = exp.mergeDoctorLists([
      [{ name: 'Dr. Krajewski', byPlanId: { 'H1036-054C': 'Out of network' } }],
      [{ name: 'Dr. Eduardo Krajewski', byPlanId: { 'H1036-054C': 'In network' } }],
    ], [humana054]);
    assert.equal(merged.length, 1);
    assert.match(merged[0].statuses[0], /need more info/i);
  });

  it('"show me Doctors Health, Solis, Devoted" exports only the plans that answer showed', () => {
    const thread = 'Compare H1036-054C, H1035-017, H1036-305 … Doctors DrMax-Dade H4140-022, Solis Wellness H0982-016, Devoted CORE 001 H1290-001';
    const out = exp.resolveExportPlans([drMax, plan('H0982-016', 'Solis', 'Solis Wellness'), devoted], thread, {
      latestUserText: '1. no 2. cardiovascular disorder 3. Yavagal and Krajewski correct. Show me Doctors Health, Solis, Devoted',
      rememberedPlans: [humana054, humana305],
    });
    assert.deepEqual(out.map((p) => p.planId), ['H4140-022', 'H0982-016', 'H1290-001']);
  });

  it('Max asking for the client name is not an off-grid benefit row', () => {
    const asked = exp.askedOffGridBenefits('Want the Excel/PDF? Click Export (need the client\u2019s full name for the title). I need the client\'s full name.');
    assert.equal(asked.asked, false);
  });
});

describe('export doctor list ignores scraped junk', () => {
  const plans = [{ planId: 'H1036-065C', planName: 'Humana Gold Plus' }, { planId: 'H1045-005', planName: 'UHC Preferred' }];
  const text = [
    'Doctors: Dr. Ashwin Mehta, Dr. Barry Sarkell',
    '- Dr. Ashwin Mehta: H1045-005 IN',
    '- Dr. Barry Sarkell: H1045-005 OUT',
    'Dr. H1045-005 In',
    'Dr. H1036-065c Not Confirmed',
    'Dr. Sarkell. Dr. Aguiar',
  ].join('\n');
  it('findDoctorNames/extractDoctors keep only real names', () => {
    const names = exp.extractDoctors(text, plans).map((d) => d.name);
    assert.deepEqual(names.sort(), ['Dr. Ashwin Mehta', 'Dr. Barry Sarkell']);
  });
  it('mergeDoctorLists cleans annotated and plan-id rows', () => {
    const merged = exp.mergeDoctorLists([[
      { name: 'Dr. Ashwin Mehta' },
      { name: 'Dr. Ashwin Mehta: H1045-005 IN' },
      { name: 'Dr. H1045-005 In' },
      { name: 'Dr. H1036-065c Not Confirmed' },
      { name: 'Dr. Sarkell. Dr. Aguiar' },
    ]], plans);
    assert.deepEqual(merged.map((d) => d.name), ['Dr. Ashwin Mehta']);
  });
});

describe('off-grid benefit detection ignores non-benefits', () => {
  it('"need a PPO" and "the official October 1 SoB" are not benefits', () => {
    const r = exp.askedOffGridBenefits('Is an HMO OK, or does she need a PPO? Does it cover the Official October 1 SoB?');
    assert.deepEqual(r.benefits, []);
  });
});

describe('off-grid benefit detection: negations and acknowledgements', () => {
  it('"dont add SNFs. i dont need those" and "Understood" add no benefits', () => {
    const r = exp.askedOffGridBenefits("dont add SNFs. i dont need those. Understood. Per your note, I don't need dialysis either.");
    assert.ok(!r.benefits.some((b) => /those|understood|ppo|sob/i.test(b)), JSON.stringify(r.benefits));
  });
  it('a real ask still works', () => {
    assert.ok(exp.askedOffGridBenefits('what is the copay for chiropractic').benefits.length >= 1);
  });
});

describe('negated benefit asks are off', () => {
  it('"dont add SNFs" does not request SNF; "show SNF days" does', () => {
    assert.equal(exp.askedOffGridBenefits("dont add SNFs. i dont need that").benefits.includes('skilled_nursing'), false);
    assert.equal(exp.askedOffGridBenefits('what is the SNF copay for these plans').benefits.includes('skilled_nursing'), true);
  });
});
