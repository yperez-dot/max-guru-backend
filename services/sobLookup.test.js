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
} = require('./sobLookup');

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
  });
});

describe('lookupSobBenefits grid then SOB', () => {
  it('uses injected SOB text and does not invent missing DME', async () => {
    const result = await lookupSobBenefits({
      planId: 'H1036-054C',
      sobUrl: 'https://example.com/sob.pdf',
      benefits: ['hearing_aids', 'skilled_nursing', 'dme'],
      sobText: `
        Hearing aids $0 copay for 2 aids every year
        Skilled nursing facility Days 1-20 $0 copay Days 21-100 $160 copay per day
      `,
      year: 2027,
    });
    assert.equal(result.verifiedAny, true);
    assert.match(result.byPlanId['H1036-054C'].fields.hearingAids.value, /\$0/);
    assert.equal(result.byPlanId['H1036-054C'].fields.hearingAids.source, 'sob');
    assert.match(result.byPlanId['H1036-054C'].fields.snfDays1to20.value, /\$0/);
    assert.match(result.byPlanId['H1036-054C'].fields.snfDays21to100.value, /\$160/);
    assert.equal(result.byPlanId['H1036-054C'].fields.dmeHospitalBed.value, null);
    assert.equal(result.byPlanId['H1036-054C'].fields.dmeHospitalBed.reason, 'not_in_sob');
    const text = formatSobLookupText(result);
    assert.match(text, /UNVERIFIED \(not_in_sob\)/);
    assert.doesNotMatch(text, /invented|from memory|2026/i);
    const exported = toExportSobBenefits(result);
    assert.ok(exported['H1036-054C'].hearingAids.value);
    assert.equal(exported['H1036-054C'].dmeHospitalBed, undefined);
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
      planId: 'H4140-023',
      benefits: ['skilled_nursing'],
    });
    assert.equal(result.verifiedAny, false);
    assert.equal(result.byPlanId['H4140-023'].fields.snfDays1to20.value, null);
    assert.equal(result.byPlanId['H4140-023'].fields.snfDays1to20.reason, 'no_sob_url');
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
    assert.match(result.byPlanId['H1609-093'].fields.hearingAids.value, /\$199/);
    assert.equal(result.byPlanId['H1609-093'].fields.snfDays1to20, undefined);
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
});
