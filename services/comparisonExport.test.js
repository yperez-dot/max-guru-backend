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

  it('omits doctors when names exist but network status is unknown', () => {
    const plans = [{ planId: 'H1045-012' }, { planId: 'H1045-061' }];
    const docs = exp.extractDoctors('Client is Arias Lazo. She sees Dr. Adam Wanner and Dr. Anila Veerani.', plans);
    assert.deepEqual(docs, []);
  });

  it('does not invent a client name', () => {
    assert.equal(exp.extractClientName('Compare H1045-012 and H1045-061 in Miami-Dade'), '');
    assert.equal(exp.extractClientName('export this as excel'), '');
  });
});

describe('Arias-like sheet model from live plan-data', () => {
  it('builds title, terminating, doctors, ordered benefits, SOB/EOC', () => {
    const plans = loadPlans();
    const a = planById(plans, 'H1045-012-000', 'Miami-Dade') || planById(plans, 'H1045-012-000');
    const b = planById(plans, 'H1045-061', 'Miami-Dade') || planById(plans, 'H1045-061');
    assert.ok(a && b, 'expected H1045-012 and H1045-061 in plan-data');

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

    const wanner = model.aoa.find((row) => row[0] === 'Dr. Adam Wanner');
    assert.deepEqual(wanner.slice(1), ['Out of network', 'Out of network']);

    const premium = model.aoa.find((row) => row[0] === 'Premium');
    assert.equal(premium[1], exp.formatBenefitValue(a.premium, 'premium'));
    assert.equal(premium[2], exp.formatBenefitValue(b.premium, 'premium'));
    assert.equal(premium.includes('$0 – $7.30 (LIS $0)'), false); // do not invent sample dollars

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
    assert.match(html, /clientName: payload.clientName/);
  });

  it('keeps chat compare rule against markdown tables', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /9\. NO MARKDOWN TABLES/);
  });
});
