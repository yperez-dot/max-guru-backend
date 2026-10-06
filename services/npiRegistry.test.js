const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractNpi,
  parseName,
  locationZip,
  rankResults,
  looksLikeOrganization,
  orgQueryVariants,
  displayName,
  formatClinicRecord,
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

describe('npiRegistry organization names', () => {
  it('does not treat a credentialed person as a clinic', () => {
    assert.equal(looksLikeOrganization('Lazaro Miguel Garcia, MD'), false);
    assert.equal(looksLikeOrganization('Miami Neurology & Rehab Specialists'), true);
  });

  it('adds a trailing wildcard so CMS can match Rehab vs Rehabilitation', () => {
    const v = orgQueryVariants('Miami Neurology & Rehab Specialists');
    assert.ok(v.includes('MIAMI NEUROLOGY*'));
  });

  it('displays NPI-2 organization_name instead of a blank person name', () => {
    assert.equal(
      displayName({
        basic: { organization_name: 'MIAMI NEUROLOGY & REHABILITATION SPECIALISTS' },
        other_names: [],
      }),
      'MIAMI NEUROLOGY & REHABILITATION SPECIALISTS'
    );
    const rec = formatClinicRecord({
      number: '1689860280',
      enumeration_type: 'NPI-2',
      basic: { organization_name: 'MIAMI NEUROLOGY & REHABILITATION SPECIALISTS' },
      addresses: [{
        address_purpose: 'LOCATION',
        address_1: '5975 SUNSET DR STE 405',
        city: 'SOUTH MIAMI',
        state: 'FL',
        postal_code: '331435198',
        telephone_number: '305-661-8040',
      }],
      practiceLocations: [{
        address_1: '11440 N KENDALL DR STE 101',
        city: 'MIAMI',
        state: 'FL',
        postal_code: '331761024',
        telephone_number: '305-459-5667',
      }],
      taxonomies: [{ desc: 'Physical Therapist', primary: true }],
      other_names: [],
    });
    assert.equal(rec.npi, '1689860280');
    assert.equal(rec.addresses.length, 2);
  });
});

const { describe: describe2, it: it2 } = require('node:test');
const assert2 = require('node:assert/strict');
const { cleanDoctorQuery } = require('./npiRegistry');

describe2('cleanDoctorQuery (reopened workup names)', () => {
  it2('strips dotted credentials and specialty hints from saved NPPES names', () => {
    assert2.equal(cleanDoctorQuery('ERNESTO PADRON M.D'), 'Ernesto Padron');
    assert2.equal(cleanDoctorQuery('OSWALDO S SANDOVAL M.D.'), 'Oswaldo S Sandoval');
    assert2.equal(cleanDoctorQuery('ALFRED ALEXANDER DESIMONE M.D.'), 'Alfred Alexander Desimone');
    assert2.equal(cleanDoctorQuery('Dr. Howard Bush, MD, FACC'), 'Howard Bush');
    assert2.equal(cleanDoctorQuery('Howard Bush Cardio'), 'Howard Bush');
    assert2.equal(cleanDoctorQuery('Jorge Diaz PCP'), 'Jorge Diaz');
  });
  it2('keeps clinic names and NPIs usable', () => {
    assert2.equal(cleanDoctorQuery('EYE SURGERY ASSOCIATES LLC'), 'Eye Surgery Associates');
    assert2.equal(cleanDoctorQuery('1417108895'), '1417108895');
  });
});

describe('doctor match never swaps in a different person (2026-10-06 live bugs)', () => {
  const { resolveNpiRecords } = require('./npiRegistry');
  const person = (npi, first, middle, last, cred, zip, tax = 'Internal Medicine') => ({
    number: npi,
    basic: { first_name: first, middle_name: middle, last_name: last, credential: cred },
    addresses: [{ address_purpose: 'LOCATION', postal_code: `${zip}0000` }],
    taxonomies: [{ primary: true, desc: tax }],
  });
  // Fake NPPES: answers by last_name (+ first_name when sent).
  const DIR = [
    person('1932159043', 'CESAR', 'A', 'CONDE', 'MD', '33172'),
    person('1111111111', 'IAN', '', 'DEL CONDE', 'MD', '33176'),
    person('1073390662', 'AMANDA', 'C', 'SOSA', 'RBT', '33172', 'Behavior Technician'),
    person('2222222222', 'MARIA', '', 'SOSA', 'MD', '33172'),
  ];
  async function withNppes(fn) {
    const saved = global.fetch;
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      const last = (q.get('last_name') || '').toUpperCase();
      const first = (q.get('first_name') || '').toUpperCase();
      const results = DIR.filter((r) => r.basic.last_name === last && (!first || r.basic.first_name === first));
      return { ok: true, json: async () => ({ results: q.get('enumeration_type') === 'NPI-2' ? [] : results }) };
    };
    try { return await fn(); } finally { global.fetch = saved; }
  }

  it('"Ian Del Conde" → Ian Del Conde, not Cesar A Conde', async () => {
    const r = await withNppes(() => resolveNpiRecords({ doctorName: 'Ian Del Conde', zip: '33172' }));
    assert.equal(r[0].number, '1111111111');
  });

  it('"Carlos Sosa" with no Carlos Sosa on file → no match (never Amanda Sosa, RBT, or Maria Sosa)', async () => {
    const r = await withNppes(() => resolveNpiRecords({ doctorName: 'Carlos Sosa', zip: '33172' }));
    assert.deepEqual(r.map((x) => x.number), []);
  });

  it('first name outranks ZIP; non-providers drop out', () => {
    const ranked = rankResults([
      person('1', 'AMANDA', '', 'SOSA', 'RBT', '33172', 'Behavior Technician'),
      person('2', 'CARLOS', '', 'SOSA', 'MD', '33010'),
    ], { zip: '33172', firstName: 'Carlos' });
    assert.equal(ranked[0].number, '2');
  });
});
