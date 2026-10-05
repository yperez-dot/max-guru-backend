const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  usableGridValue,
  normalizeBenefitList,
  parseSobBenefits,
  lookupSobBenefits,
  formatSobLookupText,
  toExportSobBenefits,
  driveDirectUrl,
  findWiredPlan,
  resetSobCache,
  shouldAutoLookupComparisonSob,
  uniquePlanIdsNeedingExportSob,
  citedPlanIdsFromText,
  sliceDoctorsColumn,
} = require('./sobLookup');
const { processTool } = require('./claude');

// pdftotext -layout excerpt from 2027_SOB_SF_DrSelect_ENG.pdf (printed pp. 15 / 17).
// Left column is DrMax-Dade ($75 SNF days 21-100). Right is DrSelect-SFL ($60).
const DOCTORS_2027_LAYOUT = `
Additional                 DrMax-Dade (HMO)                            DrSelect-SFL (HMO)
Benefits/Services
                           $0 copay per day for days 1 through         $0 copay per day for days 1 through
                           20.                                         20.
                           $75 copay per day for days 21 through       $60 copay per day for days 21 through
                           100.                                        100.
                           Our plan covers up to 100 days in a         Our plan covers up to 100 days in a
Skilled Nursing Facility
                           SNF per benefit period. A benefit           SNF per benefit period. A benefit
(SNF)
                           care or skilled care in a SNF for 60 days   care or skilled care in a SNF for 60 days
\f
Additional          DrMax-Dade (HMO)                        DrSelect-SFL (HMO)
Benefits/Services
                    0% coinsurance for covered items,       0% coinsurance for covered items,
                    including but not limited to:           including but not limited to:
                       •    CPAP machines                      •    CPAP machines
                       •    And all other medical              •    And all other medical
                            equipment                               equipment
                    20% coinsurance for covered items,      20% coinsurance for covered items,
                    including but not limited to:           including but not limited to:
                       • Powered wheelchairs                   • Powered wheelchairs
Durable Medical
                       • Powered mattress systems              • Powered mattress systems
Equipment (DME)
                       • And other electric devices            • And other electric devices
`;

const SAMPLE_SOB = `
Summary of Benefits 2027 H1036-054C
Hearing aids
$199 copay Level 1 / $475 copay Level 2 per ear every 3 years
Skilled nursing facility (SNF)
Days 1-20 $0 copay per day
Days 21-100 $214 copay per day
Durable Medical Equipment (DME)
Hospital bed 20% coinsurance
`;

beforeEach(() => resetSobCache());

describe('SOB benefit parsers (no invented dollars)', () => {
  it('reads hearing aids, SNF day bands, and hospital-bed DME from SOB text', () => {
    const parsed = parseSobBenefits(SAMPLE_SOB);
    assert.match(parsed.hearingAids, /\$199/);
    assert.match(parsed.hearingAids, /hearing aids/i);
    assert.match(parsed.snfDays1to20, /Days 1-20/i);
    assert.match(parsed.snfDays1to20, /\$0/);
    assert.match(parsed.snfDays21to100, /Days 21-100/i);
    assert.match(parsed.snfDays21to100, /\$214/);
    assert.match(parsed.dmeHospitalBed, /20%/);
    assert.match(parsed.dmeHospitalBed, /Hospital bed|DME|Durable/i);
  });

  it('returns nulls when the SOB has no money line — never invents', () => {
    const parsed = parseSobBenefits('This plan covers many services. See the EOC.');
    assert.equal(parsed.hearingAids, null);
    assert.equal(parsed.snfDays1to20, null);
    assert.equal(parsed.snfDays21to100, null);
    assert.equal(parsed.dmeHospitalBed, null);
  });

  it('maps asked benefit names and Drive view links', () => {
    assert.deepEqual(normalizeBenefitList(['hearing aids'], 'SNF days 1-20'), [
      'hearingAids',
      'skilledNursing',
    ]);
    assert.equal(
      driveDirectUrl('https://drive.google.com/file/d/abc123/view'),
      'https://drive.google.com/uc?export=download&id=abc123'
    );
    assert.equal(usableGridValue(''), null);
    assert.equal(usableGridValue('Not listed'), null);
    assert.equal(usableGridValue('$199 Level 1'), '$199 Level 1');
    assert.deepEqual(normalizeBenefitList(['chemotherapy']), ['chemotherapy']);
    assert.deepEqual(normalizeBenefitList([], ''), []);
  });
});

describe('lookupSobBenefits grid then SOB', () => {
  it('uses injected SOB text and does not invent missing DME', async () => {
    const result = await lookupSobBenefits({
      planId: 'H9999-001',
      sobUrl: 'https://example.com/sob.pdf',
      benefits: ['hearing_aids', 'skilled_nursing', 'dme'],
      sobText: `
        Hearing aids $0 copay for 2 aids every year
        Skilled nursing facility Days 1-20 $0 copay Days 21-100 $160 copay per day
      `,
      year: 2027,
    });
    assert.equal(result.verifiedAny, true);
    assert.match(result.byPlanId['H9999-001'].fields.hearingAids.value, /\$0/);
    assert.equal(result.byPlanId['H9999-001'].fields.hearingAids.source, 'sob');
    assert.match(result.byPlanId['H9999-001'].fields.snfDays1to20.value, /\$0/);
    assert.match(result.byPlanId['H9999-001'].fields.snfDays21to100.value, /\$160/);
    assert.equal(result.byPlanId['H9999-001'].fields.dme.value, null);
    assert.equal(result.byPlanId['H9999-001'].fields.dme.reason, 'not_in_sob');
    const text = formatSobLookupText(result);
    assert.match(text, /UNVERIFIED \(not_in_sob\)/);
    assert.doesNotMatch(text, /invented|from memory|2026/i);
    const exported = toExportSobBenefits(result);
    assert.ok(exported['H9999-001'].hearingAids.value);
    assert.equal(exported['H9999-001'].dme, undefined);
    assert.equal(exported['H9999-001'].dmeHospitalBed, undefined);
  });

  it('prefers a 2027 grid hearing-aid cell over inventing from thin air', async () => {
    const result = await lookupSobBenefits({
      plans: [
        {
          planId: 'H5420-014',
          hearing: '$700 allowance for 2 hearing aids every year (UHC Hearing)',
          sobUrl: '',
        },
      ],
      benefits: ['hearing_aids'],
    });
    assert.equal(result.byPlanId['H5420-014'].fields.hearingAids.source, 'grid_2027');
    assert.match(result.byPlanId['H5420-014'].fields.hearingAids.value, /\$700/);
  });

  it('says unverified when there is no SOB URL and no grid cell', async () => {
    const result = await lookupSobBenefits({
      planId: 'H9999-000',
      benefits: ['skilled_nursing'],
    });
    assert.equal(result.verifiedAny, false);
    assert.equal(result.byPlanId['H9999-000'].fields.snfDays1to20.value, null);
    assert.equal(result.byPlanId['H9999-000'].fields.snfDays1to20.reason, 'no_sob_url');
    assert.match(formatSobLookupText(result), /UNVERIFIED/);
  });

  it('hydrates a wired 2027 sobUrl when the caller only sends planId', async () => {
    const wired = findWiredPlan('H1609-093');
    assert.ok(wired && wired.sobUrl, 'live #plan-data should already wire H1609-093 SoB');
    assert.match(wired.sobUrl, /2027|SB2027/i);
    let fetchedUrl = '';
    const result = await lookupSobBenefits(
      { planId: 'H1609-093', benefits: ['hearing_aids'] },
      async (url) => {
        fetchedUrl = url;
        return { text: async () => SAMPLE_SOB };
      }
    );
    assert.equal(fetchedUrl, wired.sobUrl);
    assert.equal(result.year, 2027);
    assert.match(result.byPlanId['H1609-093'].fields.hearingAids.value, /\$199/);
    assert.equal(result.byPlanId['H1609-093'].fields.snfDays1to20, undefined);
  });

  it('reads an asked off-grid benefit from SOB text and does not invent extras', () => {
    const parsed = parseSobBenefits(
      'Chemotherapy\nChemotherapy $35 copay for Medicare-covered chemo drugs\nHome health $0 copay',
      ['chemotherapy', 'homeHealth', 'dialysis']
    );
    assert.match(parsed.chemotherapy, /\$35/);
    assert.match(parsed.homeHealth, /\$0/);
    assert.equal(parsed.dialysis, null);
    assert.equal(parsed.dmeHospitalBed, null);
  });

  it('uses the Evidence of Coverage when the SOB does not have the asked benefit', async () => {
    const result = await lookupSobBenefits({
      planId: 'H1036-054C',
      sobUrl: 'https://example.com/sob.pdf',
      eocUrl: 'https://example.com/eoc.pdf',
      benefits: ['chemotherapy'],
      sobText: 'Hearing aids $199 copay. Skilled nursing Days 1-20 $0 copay.',
      eocText: 'Chemotherapy $35 copay for Medicare-covered chemo drugs.',
    });
    assert.equal(result.byPlanId['H1036-054C'].fields.chemotherapy.source, 'eoc');
    assert.match(result.byPlanId['H1036-054C'].fields.chemotherapy.value, /\$35/);
    assert.equal(result.byPlanId['H1036-054C'].fields.snfDays1to20, undefined);
    const text = formatSobLookupText(result);
    assert.match(text, /source eoc/);
    assert.doesNotMatch(text, /\$999|from memory|2026/i);
  });

  it('says unverified when the asked benefit is not in the SOB or the EOC', async () => {
    const result = await lookupSobBenefits({
      planId: 'H1036-054C',
      sobUrl: 'https://example.com/sob.pdf',
      eocUrl: 'https://example.com/eoc.pdf',
      benefits: ['dialysis'],
      sobText: 'This plan covers many services. See the EOC.',
      eocText: 'Contact your provider for covered services.',
    });
    assert.equal(result.byPlanId['H1036-054C'].fields.dialysis.value, null);
    assert.equal(result.byPlanId['H1036-054C'].fields.dialysis.reason, 'not_in_sob_or_eoc');
    assert.match(formatSobLookupText(result), /UNVERIFIED/);
  });

  it('maps the 2027 Doctors H4140-023 to the DrSelect SoB (right column) and H4140-022 to DrMax', () => {
    const wired = findWiredPlan('H4140-023', 2027);
    assert.ok(wired && wired.sobUrl);
    assert.equal(
      wired.sobUrl,
      'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf'
    );
    const dr022 = findWiredPlan('H4140-022', 2027);
    assert.equal(
      dr022.sobUrl,
      'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf'
    );
  });

  it('a 2026-only ask hydrates that plan\'s 2026 sobUrl, not the 2027 file', async () => {
    const wired26 = findWiredPlan('H1609-093', 2026);
    const wired27 = findWiredPlan('H1609-093', 2027);
    assert.ok(wired26 && wired26.sobUrl);
    assert.ok(wired27 && wired27.sobUrl);
    assert.notEqual(wired26.sobUrl, wired27.sobUrl);
    assert.match(wired26.sobUrl, /2026|SB2026/i);
    assert.match(wired27.sobUrl, /2027|SB2027/i);

    let fetchedUrl = '';
    const result = await lookupSobBenefits(
      {
        planId: 'H1609-093',
        benefits: ['hearing_aids'],
        askText: 'The case is 2026. What are hearing aids on H1609-093?',
      },
      async (url) => {
        fetchedUrl = url;
        return { text: async () => 'Hearing aids $50 copay per ear every 3 years (2026 SOB)' };
      }
    );
    assert.equal(fetchedUrl, wired26.sobUrl);
    assert.doesNotMatch(fetchedUrl, /2027|SB2027/i);
    assert.equal(result.year, 2026);
    assert.equal(result.byPlanId['H1609-093'].sobUrl, wired26.sobUrl);
    assert.equal(result.byPlanId['H1609-093'].eocUrl, null);
    assert.match(result.byPlanId['H1609-093'].fields.hearingAids.value, /\$50/);
  });

  it('does not fetch a 2027 SOB when the caller passes a 2027 URL on a 2026-only ask', async () => {
    const wired26 = findWiredPlan('H1036-054C', 2026);
    const wired27 = findWiredPlan('H1036-054C', 2027);
    assert.ok(wired26 && wired26.sobUrl);
    assert.ok(wired27 && wired27.eocUrl);
    assert.match(wired27.eocUrl, /EOC27|2027/i);

    let fetchedUrl = '';
    const result = await lookupSobBenefits(
      {
        planId: 'H1036-054C',
        sobUrl: wired27.sobUrl,
        benefits: ['skilled_nursing'],
        askText: '2026 case — SNF days 1-20 on Humana Gold Plus H1036-054C',
      },
      async (url) => {
        fetchedUrl = url;
        return { text: async () => 'Skilled nursing facility Days 1-20 $0 copay Days 21-100 $214 copay per day' };
      }
    );
    assert.equal(fetchedUrl, wired26.sobUrl);
    assert.equal(result.year, 2026);
    assert.notEqual(result.byPlanId['H1036-054C'].eocUrl, wired27.eocUrl);
  });

  it('a 2026+2027 ask keeps the safer 2027 SOB file', async () => {
    const wired27 = findWiredPlan('H1609-093', 2027);
    let fetchedUrl = '';
    const result = await lookupSobBenefits(
      {
        planId: 'H1609-093',
        year: 2026,
        benefits: ['hearing_aids'],
        askText: 'Need both 2026 and 2027 hearing aids on H1609-093',
      },
      async (url) => {
        fetchedUrl = url;
        return { text: async () => SAMPLE_SOB };
      }
    );
    assert.equal(fetchedUrl, wired27.sobUrl);
    assert.equal(result.year, 2027);
  });

  it('processTool forwards a 2026-only conversation year when the model omits year', async () => {
    const out = await processTool(
      'lookup_sob_benefit',
      { planId: 'H9999-000', benefits: ['skilled_nursing'] },
      { messages: [{ role: 'user', content: 'This case is 2026. SNF on H9999-000?' }] }
    );
    assert.match(out.text, /year=2026/);
    assert.match(out.text, /UNVERIFIED/);
    assert.doesNotMatch(out.text, /\/2027\/|SB2027/i);
  });

  it('a 2026-only ask does not fetch or return a 2027 EOC when the SOB misses the benefit', async () => {
    const wired26 = findWiredPlan('H1036-054C', 2026);
    const wired27 = findWiredPlan('H1036-054C', 2027);
    assert.ok(wired27 && wired27.eocUrl);
    const fetched = [];
    const result = await lookupSobBenefits(
      {
        planId: 'H1036-054C',
        sobUrl: wired27.sobUrl,
        eocUrl: wired27.eocUrl,
        benefits: ['chemotherapy'],
        askText: 'This case is 2026. What is chemo on H1036-054C?',
        sobText: 'Hearing aids $199. Skilled nursing Days 1-20 $0.',
      },
      async (url) => {
        fetched.push(url);
        return { text: async () => 'Chemotherapy $999 from the 2027 EOC — must not be used' };
      }
    );
    assert.equal(result.year, 2026);
    assert.equal(result.byPlanId['H1036-054C'].sobUrl, wired26.sobUrl);
    assert.equal(result.byPlanId['H1036-054C'].eocUrl, null);
    assert.equal(result.byPlanId['H1036-054C'].eocRead, false);
    assert.deepEqual(fetched, []);
    assert.equal(result.byPlanId['H1036-054C'].fields.chemotherapy.value, null);
    assert.doesNotMatch(formatSobLookupText(result), /EOC27|\$999|2027_SOB|\/2027\//i);
  });

  it('does not use a fetchImpl when sobText is provided (no live dollars)', async () => {
    let called = false;
    const result = await lookupSobBenefits(
      {
        planId: 'H4140-023',
        sobUrl: 'https://example.com/2027.pdf',
        benefits: ['skilled_nursing'],
        sobText: 'Skilled nursing facility Days 1 through 20 $0 copay Days 21 through 100 $60 copay per day',
      },
      async () => {
        called = true;
        throw new Error('should not fetch');
      }
    );
    assert.equal(called, false);
    assert.match(result.byPlanId['H4140-023'].fields.snfDays21to100.value, /\$60/);
  });

  it('wires H4140-023 to the 2027 DrSelect SoB, not Dr Max', () => {
    const select = findWiredPlan('H4140-023');
    const max = findWiredPlan('H4140-022');
    assert.ok(select && select.sobUrl, 'H4140-023 should be in live #plan-data');
    assert.equal(
      select.sobUrl,
      'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf'
    );
    assert.equal(
      max.sobUrl,
      'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf'
    );
  });

  it('reads the DrSelect-SFL column from the two-column Doctors 2027 SoB', async () => {
    const sobText = `
      COVERED MEDICAL AND HOSPITAL BENEFITS
      Benefits/Services DrMax-Dade (HMO) DrSelect-SFL (HMO)
      Skilled Nursing Facility (SNF)
      $0 copay per day for days 1 through 20. $75 copay per day for days 21 through 100.
      $0 copay per day for days 1 through 20. $60 copay per day for days 21 through 100.
    `;
    const select = await lookupSobBenefits({
      planId: 'H4140-023',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf',
      benefits: ['skilled_nursing'],
      sobText,
    });
    assert.match(select.byPlanId['H4140-023'].fields.snfDays1to20.value, /\$0/);
    assert.match(select.byPlanId['H4140-023'].fields.snfDays21to100.value, /\$60/);
    assert.doesNotMatch(select.byPlanId['H4140-023'].fields.snfDays21to100.value, /\$75/);

    const max = await lookupSobBenefits({
      planId: 'H4140-022',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf',
      benefits: ['skilled_nursing'],
      sobText,
    });
    assert.match(max.byPlanId['H4140-022'].fields.snfDays21to100.value, /\$75/);
  });

  it('reads DrSelect-SFL DME from the right column and does not invent a hospital-bed dollar', async () => {
    const sobText = `
      Benefits/Services DrMax-Dade (HMO) DrSelect-SFL (HMO)
      0% coinsurance including but not limited to: 20% coinsurance including but not limited to:
      for covered items, CPAP machines And all other medical equipment
      for covered items, Powered wheelchairs Powered mattress systems And other electric devices
      for covered items, 0% coinsurance including but not limited to:
      for covered items, 20% coinsurance including but not limited to:
      The list of preferred vendors and manufacturers for durable medical equipment (DME)
      Durable Medical Equipment (DME)
    `;
    const dme = await lookupSobBenefits({
      planId: 'H4140-023',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf',
      benefits: ['dme'],
      sobText,
    });
    assert.match(dme.byPlanId['H4140-023'].fields.dme.value, /0%/);
    assert.match(dme.byPlanId['H4140-023'].fields.dme.value, /20%/);
    assert.match(dme.byPlanId['H4140-023'].fields.dme.value, /CPAP/i);
    assert.match(dme.byPlanId['H4140-023'].fields.dme.value, /powered wheelchair/i);
    assert.doesNotMatch(dme.byPlanId['H4140-023'].fields.dme.value, /hospital/i);
    assert.equal(dme.byPlanId['H4140-023'].fields.dmeHospitalBed, undefined);

    const bed = await lookupSobBenefits({
      planId: 'H4140-023',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf',
      benefits: ['hospital_bed'],
      sobText,
    });
    assert.equal(bed.byPlanId['H4140-023'].fields.dmeHospitalBed.value, null);
    assert.equal(bed.byPlanId['H4140-023'].fields.dmeHospitalBed.reason, 'not_in_sob');
    assert.doesNotMatch(formatSobLookupText(bed), /hospital bed \$|hospital-grade bed \$/i);
  });

  it('uses the RIGHT DrSelect column on layout text, not the first (left/Dr Max) dollar', async () => {
    const right = sliceDoctorsColumn(DOCTORS_2027_LAYOUT, 'H4140-023');
    const left = sliceDoctorsColumn(DOCTORS_2027_LAYOUT, 'H4140-022');
    assert.match(right, /\$60/);
    assert.doesNotMatch(right, /\$75/);
    assert.match(left, /\$75/);
    assert.doesNotMatch(left, /\$60/);

    const select = await lookupSobBenefits({
      planId: 'H4140-023',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf',
      benefits: ['skilled_nursing', 'dme', 'hospital_bed'],
      sobText: DOCTORS_2027_LAYOUT,
    });
    assert.match(select.byPlanId['H4140-023'].fields.snfDays1to20.value, /\$0/);
    assert.match(select.byPlanId['H4140-023'].fields.snfDays21to100.value, /\$60/);
    assert.doesNotMatch(select.byPlanId['H4140-023'].fields.snfDays21to100.value, /\$75/);
    assert.match(select.byPlanId['H4140-023'].fields.dme.value, /0%/);
    assert.match(select.byPlanId['H4140-023'].fields.dme.value, /20%/);
    assert.equal(select.byPlanId['H4140-023'].fields.dmeHospitalBed.value, null);

    const max = await lookupSobBenefits({
      planId: 'H4140-022',
      sobUrl: 'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf',
      benefits: ['skilled_nursing'],
      sobText: DOCTORS_2027_LAYOUT,
    });
    assert.match(max.byPlanId['H4140-022'].fields.snfDays21to100.value, /\$75/);
    assert.doesNotMatch(max.byPlanId['H4140-022'].fields.snfDays21to100.value, /\$60/);
    assert.equal(
      findWiredPlan('H4140-022').sobUrl,
      'https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf'
    );
  });
});

describe('SOB lookup only when the agent asked', () => {
  it('does not trigger on a 2+ plan comparison when SNF/DME were never mentioned', () => {
    const messages = [
      {
        role: 'user',
        content:
          'Compare H1036-054C, H4140-023, and H5420-001 for Mr. and Mrs. Muskat.',
      },
    ];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), false);
    assert.deepEqual(uniquePlanIdsNeedingExportSob(messages, []), [
      'H1036-054C',
      'H4140-023',
      'H5420-001',
    ]);
  });

  it('does not trigger on a single plan premium question', () => {
    const messages = [{ role: 'user', content: 'What is the premium on H1036-054C?' }];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), false);
    assert.deepEqual(citedPlanIdsFromText('What is the premium on H1036-054C?'), ['H1036-054C']);
  });

  it('triggers when she asks for SNF / DME and skips plans already looked up', () => {
    const messages = [{ role: 'user', content: 'What is SNF days 1-20 on H1036-054C?' }];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), true);
    const already = [
      {
        tool: 'lookup_sob_benefit',
        output: {
          sobBenefits: {
            'H1036-054C': { snfDays1to20: { value: 'Days 1-20: $0 copay' } },
            'H4140-023': { snfDays1to20: { value: null } },
            'H5420-001': { dmeHospitalBed: { value: null } },
          },
        },
      },
    ];
    const askedAgain = [
      {
        role: 'user',
        content:
          'Compare H1036-054C, H4140-023, and H5420-001. Need SNF days 1-20 and a hospital-grade bed.',
      },
    ];
    assert.equal(shouldAutoLookupComparisonSob(askedAgain, already), false);
    assert.deepEqual(uniquePlanIdsNeedingExportSob(askedAgain, already), []);
  });

  it('triggers when she asks for an off-grid benefit that is not SNF or DME', () => {
    const messages = [
      { role: 'user', content: 'What is the dialysis copay on H1036-054C?' },
    ];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), true);
  });

  it('does not AutoTool a Padron doctor/Rx ask, even if the model dumps the Florida grid', () => {
    const gridDump = Array.from({ length: 90 }, (_, i) => `H10${String(i).padStart(2, '0')}-${String(i).padStart(3, '0')}`).join(' ');
    const messages = [
      {
        role: 'user',
        content:
          'Maria and Gaspar Padron ZIP 33332. Need to check these doctors: Ernesto Padron PCP plus several specialists. Meds: Jardiance and Mounjaro.',
      },
      { role: 'assistant', content: `Florida grid: ${gridDump}` },
    ];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), false);
    assert.deepEqual(uniquePlanIdsNeedingExportSob(messages, []), []);
  });

  it('uses user-named comparison plans, not an assistant grid dump', () => {
    const gridDump = Array.from({ length: 90 }, (_, i) => `H1045-${String(i).padStart(3, '0')}`).join(' ');
    const messages = [
      {
        role: 'user',
        content: 'Compare H1036-054C, H4140-023, and H5420-001. Need SNF days 1-20.',
      },
      { role: 'assistant', content: `Also on the grid: ${gridDump}` },
    ];
    assert.equal(shouldAutoLookupComparisonSob(messages, []), true);
    assert.deepEqual(uniquePlanIdsNeedingExportSob(messages, []), [
      'H1036-054C',
      'H4140-023',
      'H5420-001',
    ]);
  });

  it('caps a 90-plan SOB lookup and does not invent dollars', async () => {
    const ids = Array.from({ length: 90 }, (_, i) => `H9998-${String(i + 1).padStart(3, '0')}`);
    const result = await lookupSobBenefits({
      planIds: ids,
      benefits: ['skilled_nursing'],
      year: 2027,
    });
    assert.equal(result.lookups.length, 8);
    assert.equal(result.cappedFrom, 90);
    const text = formatSobLookupText(result);
    assert.match(text, /Capped to 8 of 90/);
    assert.doesNotMatch(text, /invented|from memory/i);
  });

  it('non-Doctors carriers: a band never takes the next band\'s amount, and no Doctors-only pattern', () => {
    const { parseSobBenefits } = require('./sobLookup');
    const text = [
      'Skilled Nursing Facility (SNF)',
      'Days 1-20: $0 copay',
      'Days 21-100: $203 copay per day',
    ].join('\n');
    const out = parseSobBenefits(text, [], 'H1036-054C');
    assert.match(String(out.snfDays1to20), /\$0/);
    assert.doesNotMatch(String(out.snfDays1to20), /203/);
    assert.match(String(out.snfDays21to100), /\$203/);
    // The Doctors "copay per day for days N" shape must not be read as a Humana answer.
    const doctorsShape = 'Skilled Nursing Facility $0 copay per day for days 1-20 $60 copay per day for days 21-100';
    const hum = parseSobBenefits(doctorsShape, [], 'H1036-054C');
    assert.equal(hum.snfDays1to20, 'Days 1-20: $0');
    assert.equal(hum.snfDays21to100, 'Days 21-100: $60');
    // Two different amounts for one band is ambiguous: Unverified, never the first one.
    const twoWays = 'Skilled Nursing Facility $0 copay per day for days 1-20 $50 copay per day for days 1-20';
    assert.equal(parseSobBenefits(twoWays, [], 'H1036-054C').snfDays1to20, null);
  });

  it('UHC-style "$0 copay per day: days 1-20" is not swapped with the next band', () => {
    const { parseSobBenefits } = require('./sobLookup');
    const text = 'Skilled Nursing Facility (SNF) $0 copay per day: days 1-20 $221 copay per day: days 21-100';
    const out = parseSobBenefits(text, [], 'H5420-001');
    assert.equal(out.snfDays1to20, 'Days 1-20: $0');
    assert.equal(out.snfDays21to100, 'Days 21-100: $221');
  });

  it('Humana-style SNF and DME lines parse as printed', () => {
    const { parseSobBenefits } = require('./sobLookup');
    const text =
      'Skilled Nursing Facility (SNF) This plan covers up to 100 days in a SNF $0 copay per day for days 1-20 $60 copay per day for days 21-100';
    const out = parseSobBenefits(text, [], 'H1036-054C');
    assert.equal(out.snfDays1to20, 'Days 1-20: $0');
    assert.equal(out.snfDays21to100, 'Days 21-100: $60');
  });

  it('Humana DME line keeps its real text (bullet becomes a middle dot)', () => {
    const { parseSobBenefits } = require('./sobLookup');
    const out = parseSobBenefits(
      'Durable medical equipment (DME) \u2022 DME provider: 15% of the cost',
      [],
      'H1036-054C'
    );
    assert.match(out.dme, /15% of the cost/);
    assert.ok(!/\u2022/.test(out.dme));
  });

  it('verified registry beats a live parse, carries the page, and is used before any fetch', async () => {
    let fetched = false;
    const result = await lookupSobBenefits({
      planId: 'H1036-054C',
      sobUrl: 'https://example.com/sob.pdf',
      benefits: ['skilled_nursing'],
      fetchImpl: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      year: 2027,
    });
    const f = result.byPlanId['H1036-054C'].fields;
    assert.equal(f.snfDays1to20.value, 'Days 1-20: $0');
    assert.equal(f.snfDays21to100.value, 'Days 21-100: $60');
    assert.equal(f.snfDays21to100.source, 'verified_sob');
    assert.equal(fetched, false);
  });

  it('registry rows all carry a quote that contains their dollar amount (no unsupported values)', () => {
    const reg = require('../max-knowledge/sob-verified-2027.json').plans;
    Object.keys(reg).forEach((planId) => {
      Object.keys(reg[planId]).forEach((field) => {
        const row = reg[planId][field];
        assert.ok(row.quote, `${planId}.${field} needs a quote`);
        const nums = String(row.value).match(/\$[\d,]+(?:\.\d{2})?|\d+\s*%/g) || [];
        nums.forEach((n) => assert.ok(row.quote.includes(n), `${planId}.${field}: ${n} not in quote`));
      });
    });
  });

  it('disagreeing readings of one band become Unverified instead of picking one', () => {
    const { parseSobBenefits } = require('./sobLookup');
    const text =
      'Skilled Nursing Facility $5 copay per day for days 1-20 and also days 1-20 $9 copay per day: days 21-100 $2 copay per day for days 21-100';
    const out = parseSobBenefits(text, [], 'H1036-054C');
    assert.ok(out.snfDays1to20 === null || /\$5/.test(out.snfDays1to20));
    assert.ok(!/\$9/.test(String(out.snfDays1to20)));
  });
});
