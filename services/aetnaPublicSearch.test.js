const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  CARRIER_LABEL,
  PLAN_YEAR,
  formatLatLng,
  lastNameFromDisplay,
  npiMatches,
  isInNetworkStatus,
  formatPlanLabel,
  buildTaxonomyBody,
  buildMedicareSearchBody,
  parseSpaCredentials,
} = require('./aetnaPublicSearch');

describe('aetnaPublicSearch helpers', () => {
  it('formats latlng as a comma string (OpenAPI type is string)', () => {
    assert.equal(formatLatLng(25.65815, -80.358991), '25.65815,-80.358991');
  });

  it('pulls last name from taxonomy display names', () => {
    assert.equal(lastNameFromDisplay('Mireya Garcia, MD'), 'Garcia');
    assert.equal(lastNameFromDisplay('Andrew Michael Rivera, MD'), 'Rivera');
    assert.equal(lastNameFromDisplay('Garcia Rivera, Ricardo, MD'), 'Rivera');
  });

  it('matches NPI as string or number', () => {
    assert.equal(npiMatches('1497949424', 1497949424), true);
    assert.equal(npiMatches('1306409339', '1497949424'), false);
  });

  it('treats INN / In Network as in-network', () => {
    assert.equal(isInNetworkStatus('In Network'), true);
    assert.equal(isInNetworkStatus('INN'), true);
    assert.equal(isInNetworkStatus('OON'), false);
  });

  it('keeps Aetna plan_name which already has the CMS id', () => {
    const label = formatPlanLabel({
      plan_id: 'H1609-094-2026',
      plan_name: 'Aetna Medicare Chronic Care (HMO C-SNP) - H1609-094',
    });
    assert.match(label, /H1609-094/);
    assert.equal(CARRIER_LABEL, 'Aetna Medicare');
  });

  it('builds taxonomy + medicare_plans search bodies', () => {
    const tax = buildTaxonomyBody({
      q: '1497949424',
      latlng: '25.65815,-80.358991',
      countyCode: '12086',
    });
    assert.deepEqual(tax.supported_types, ['practitioner']);
    assert.equal(tax.public_site_id, 'medicare');
    assert.equal(tax.plan_year, PLAN_YEAR);

    const search = buildMedicareSearchBody({
      q: 'Garcia',
      latlng: '25.65815,-80.358991',
      countyCode: '12086',
      lastName: 'Garcia',
      offset: 50,
    });
    assert.equal(search.medicare_plans.plan_type, 'IND');
    assert.equal(search.provider_filters.name, 'Garcia');
    assert.equal(search.offset, 50);
    assert.equal(typeof search.latlng, 'string');
  });

  it('parses public SPA client id and token from Aetna HTML', () => {
    const html = '{"publicTokenClientId":"8b2a1b1b-6d83-4855-8e5f-10cb198e6769","/ahweb/public_client_token/prod":"abcSecret"}';
    const parsed = parseSpaCredentials(`window.__AHW_STORED_PARAMETERS = JSON.parse("${html.replace(/"/g, '\\"')}"); publicTokenClientId":"8b2a1b1b-6d83-4855-8e5f-10cb198e6769"`);
    // Direct form used in live HTML (unescaped JSON in the page)
    const live = parseSpaCredentials(
      '"publicTokenClientId":"8b2a1b1b-6d83-4855-8e5f-10cb198e6769","foo":1 "/ahweb/public_client_token/prod":"yD3fE8gI0oC4gQ2eB1bM0sH2hO6vA3uP0aE2vE6gT6xY6mU2qG"'
    );
    assert.equal(live.clientId, '8b2a1b1b-6d83-4855-8e5f-10cb198e6769');
    assert.equal(live.clientSecret, 'yD3fE8gI0oC4gQ2eB1bM0sH2hO6vA3uP0aE2vE6gT6xY6mU2qG');
    assert.ok(parsed.clientId);
  });
});
