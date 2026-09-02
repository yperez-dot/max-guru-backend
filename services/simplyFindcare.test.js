const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CARRIER_LABEL,
  GUEST_HEADERS,
  npiList,
  npiMatches,
  searchLastName,
  formatPlanLabel,
  buildSearchBoxBody,
  collectProviders,
  pickPlansToSearch,
} = require('./simplyFindcare');

describe('simplyFindcare helpers', () => {
  it('sends guest meta headers (token 403s without them)', () => {
    assert.equal(GUEST_HEADERS['meta-brandcd'], 'SHC');
    assert.equal(GUEST_HEADERS['meta-consumerapp'], 'FINDCARE');
    assert.equal(GUEST_HEADERS['meta-locale'], 'en_US');
  });

  it('uses the last token of a compound last name for search-box', () => {
    assert.equal(searchLastName('GARCIA RIVERA'), 'RIVERA');
    assert.equal(searchLastName('Garcia, MD'), 'Garcia');
    assert.equal(searchLastName('Tharkur'), 'Tharkur');
  });

  it('matches npiIds as string, array, or comma list', () => {
    assert.equal(npiMatches({ npiIds: '1497949424' }, '1497949424'), true);
    assert.equal(npiMatches({ npiIds: ['1497949424'] }, 1497949424), true);
    assert.equal(npiMatches({ npiId: '1306409339' }, '1497949424'), false);
    assert.deepEqual(npiList({ npiIds: '1255334991,1497949424' }), ['1255334991', '1497949424']);
  });

  it('builds search-box body with plan identifier + networks', () => {
    const body = buildSearchBoxBody({
      queryText: 'Garcia',
      plan: {
        id: 'C475C7C5931736D18633C4B00D02E321',
        prefix: '3301',
        networkList: ['SMPNTWKDSNP1'],
      },
      latitude: '25.78',
      longitude: '-80.29',
      zip: '33126',
    });
    assert.equal(body.planCategory, 'MCRIN');
    assert.equal(body.brandCode, 'SHC');
    assert.equal(body.plans[0].identifier, 'C475C7C5931736D18633C4B00D02E321');
    assert.equal(body.alphaPrefix, '3301');
    assert.deepEqual(body.typeCodes, ['P']);
    assert.equal(typeof body.distance, 'number');
  });

  it('collects provider rows from nmProviderList', () => {
    const rows = collectProviders({
      nmProviderList: [
        { providerName: 'Juan C Garcia', npiIds: '1255334991' },
        { providerName: 'Ana M. Garcia', npiIds: '1396095188' },
      ],
      uuid: 'x',
    });
    assert.equal(rows.length, 2);
    assert.equal(formatPlanLabel({ name: 'Simply Complete (HMO D-SNP)' }), 'Simply Complete (HMO D-SNP)');
    assert.equal(CARRIER_LABEL, 'Simply Healthcare');
  });

  it('searches Complete/Extra/Select before platinum variants', () => {
    const picked = pickPlansToSearch([
      { name: 'Simply Complete Platinum (HMO D-SNP)' },
      { name: 'Simply Complete (HMO D-SNP)' },
      { name: 'Simply Extra (HMO)' },
      { name: 'Simply Level (HMO C-SNP)' },
    ]);
    assert.equal(picked[0].name, 'Simply Complete (HMO D-SNP)');
    assert.equal(picked[1].name, 'Simply Extra (HMO)');
    assert.equal(picked.length, 4);
  });
});
