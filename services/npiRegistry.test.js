const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractNpi,
  parseName,
  locationZip,
  rankResults,
} = require('./npiRegistry');

describe('npiRegistry parse / extract', () => {
  it('pulls a 10-digit NPI out of a pasted agent message', () => {
    assert.equal(extractNpi('NPI: 1598792707 at Salus'), '1598792707');
    assert.equal(extractNpi('Lazaro Garcia'), null);
  });

  it('does not treat trailing MD or a practice name as the last name', () => {
    assert.deepEqual(parseName('Dr. Lazaro Miguel Garcia, MD'), {
      firstName: 'Lazaro',
      middleName: 'Miguel',
      lastName: 'Garcia',
    });
    assert.equal(parseName('Lazaro M. Garcia at Salus Health').lastName, 'Garcia');
    assert.equal(parseName('Lazaro M. Garcia at Salus Health').firstName, 'Lazaro');
    assert.equal(parseName('Garcia, Lazaro Miguel').middleName, 'Miguel');
  });
});

describe('npiRegistry ranking', () => {
  const fixtures = [
    {
      number: '1417106261',
      basic: { first_name: 'LAZARO', last_name: 'GARCIA', credential: 'Ph.D.' },
      addresses: [{ address_purpose: 'LOCATION', postal_code: '331556539' }],
    },
    {
      number: '1396233821',
      basic: { first_name: 'LAZARO', last_name: 'GARCIA', credential: 'ARNP' },
      addresses: [{ address_purpose: 'LOCATION', postal_code: '331664434' }],
    },
    {
      number: '1598792707',
      basic: { first_name: 'LAZARO', middle_name: 'MIGUEL', last_name: 'GARCIA', credential: 'MD' },
      addresses: [{ address_purpose: 'LOCATION', postal_code: '331254069' }],
    },
    {
      number: '1740729136',
      basic: { first_name: 'LAZARO', middle_name: 'F.', last_name: 'GARCIA', credential: 'M.D.' },
      addresses: [{ address_purpose: 'LOCATION', postal_code: '331756302' }],
    },
  ];

  it('keeps the 33125 Family Medicine MD even when the query ZIP is 33166', () => {
    const ranked = rankResults(fixtures, {
      zip: '33166',
      firstName: 'Lazaro',
      middleName: 'Miguel',
    });
    assert.equal(locationZip(fixtures[1]), '33166');
    assert.equal(ranked[0].number, '1396233821');
    assert.ok(ranked.some((r) => r.number === '1598792707'));
    assert.equal(ranked[1].number, '1598792707');
  });
});
