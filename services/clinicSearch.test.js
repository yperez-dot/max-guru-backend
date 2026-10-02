const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  knownSiteFor,
  isBlockedSearchUrl,
  extractCarrierLogos,
  extractPageTitle,
  logoPhrase,
  formatSiteNotes,
  searchClinicOrProvider,
} = require('./clinicSearch');
const { looksLikeOrganization, orgQueryVariants } = require('./npiRegistry');

const MNRS_INSURANCE_HTML = `
<title>Insurances | MNRS Physical Therapy</title>
<h3>Insurances Accepted at MNRS Physical Therapy</h3>
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/Aetna-Logo-tag-line-Your-global-health-partner.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/ASHP-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/AvMed-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/cigna-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/DHP-logo-2.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/geha-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/goldern-rule-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/the-hartford-logo-2.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/hphc-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/medicare-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/nalc-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/phcs-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/tricare-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/uhc-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/UAIC-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/umr-logo.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/va-logo-2.png" />
<img alt="client" data-nectar-img-src="https://miamiphysicaltherapy.com/wp-content/uploads/2021/07/gallagherbassett-logo.png" />
`;

describe('clinic identity helpers', () => {
  it('treats Miami Neurology & Rehab Specialists as an org, not a person', () => {
    assert.equal(looksLikeOrganization('Miami Neurology & Rehab Specialists'), true);
    assert.equal(looksLikeOrganization('MNRS Physical Therapy'), true);
    assert.equal(looksLikeOrganization('Lazaro Miguel Garcia, MD'), false);
  });

  it('builds a MIAMI NEUROLOGY* NPPES wildcard from the informal clinic name', () => {
    const variants = orgQueryVariants('Miami Neurology & Rehab Specialists');
    assert.ok(variants.includes('MIAMI NEUROLOGY*'));
    assert.ok(variants.some((v) => v.includes('REHABILITATION')));
  });

  it('maps MNRS to the confirmed insurances page and blocks Google SERPs', () => {
    assert.equal(
      knownSiteFor('Miami Neurology & Rehab Specialists').siteUrl,
      'https://miamiphysicaltherapy.com/insurances/'
    );
    assert.equal(isBlockedSearchUrl('https://www.google.com/search?q=mnrs'), true);
    assert.equal(isBlockedSearchUrl('https://miamiphysicaltherapy.com/insurances/'), false);
  });
});

describe('MNRS insurance-page logos (Yahoska 2026-10-02)', () => {
  it('reads logos from image filenames, not alt=client, and finds no Humana', () => {
    const listed = extractCarrierLogos(MNRS_INSURANCE_HTML);
    assert.equal(extractPageTitle(MNRS_INSURANCE_HTML), 'Insurances | MNRS Physical Therapy');
    for (const name of [
      'Aetna',
      'ASHP',
      'AvMed',
      'Cigna',
      'Doctors Healthcare',
      'GEHA',
      'Golden Rule',
      'Hartford',
      'Harvard Pilgrim',
      'Medicare',
      'NALC',
      'PHCS',
      'TRICARE',
      'UnitedHealthcare',
      'UAIC',
      'UMR',
      'VA',
      'Gallagher Bassett',
    ]) {
      assert.ok(listed.includes(name), `missing ${name}: ${listed.join(', ')}`);
    }
    assert.equal(listed.includes('Humana'), false);
  });

  it('uses Yahoska call-and-confirm wording, never verified In/Out', () => {
    const url = 'https://miamiphysicaltherapy.com/insurances/';
    const listed = extractCarrierLogos(MNRS_INSURANCE_HTML);
    assert.equal(
      logoPhrase({ askedCarrier: 'Humana', listed, siteUrl: url, foundLogo: false }),
      'Humana is not listed on their accepted-insurances page (https://miamiphysicaltherapy.com/insurances/). I recommend you call the office to confirm.'
    );
    assert.match(
      logoPhrase({ askedCarrier: 'Aetna', listed, siteUrl: url, foundLogo: true }),
      /Found a Aetna logo on their site — here's the link\. I recommend you call and confirm\./
    );
    const notes = formatSiteNotes({
      siteUrl: url,
      listed,
      askedCarrier: 'Humana',
      title: 'Insurances | MNRS Physical Therapy',
    }).join('\n');
    assert.match(notes, /not listed/i);
    assert.match(notes, /NOT definitive out-of-network/i);
    assert.match(notes, /Find Care later returns IN/i);
    assert.match(notes, /Never treat this page as verified In or Out/i);
  });
});

describe('searchClinicOrProvider live NPPES smoke', () => {
  it('resolves Miami Neurology & Rehab Specialists to NPI 1689860280', async () => {
    const result = await searchClinicOrProvider({
      name: 'Miami Neurology & Rehab Specialists',
      state: 'FL',
      askedCarrier: 'Humana',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => MNRS_INSURANCE_HTML,
      }),
    });
    const npis = (result.structured.records || []).map((r) => r.npi);
    assert.ok(npis.includes('1689860280'), `got NPIs ${npis.join(', ') || '(none)'}\n${result.text}`);
    const rec = result.structured.records.find((r) => r.npi === '1689860280');
    assert.match(rec.officialName, /MIAMI NEUROLOGY & REHABILITATION SPECIALISTS/i);
    const zips = rec.addresses.map((a) => a.zip);
    assert.ok(zips.includes('33143') || rec.addresses.some((a) => /SUNSET/i.test(a.line)));
    assert.ok(zips.includes('33176') || rec.addresses.some((a) => /KENDALL/i.test(a.line)));
    assert.equal(result.structured.site.listed.includes('Humana'), false);
    assert.ok(result.structured.site.listed.includes('Aetna'));
    assert.match(result.text, /Humana is not listed on their accepted-insurances page/);
    assert.match(result.text, /lookup_provider_network/);
    assert.match(result.text, /MNRS/);
  });
});
