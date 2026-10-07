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

  it('"Carlos Alberto Sosa Rosales" is a person, never "CARLOS ALBERTO ALSINA MORFA APRN CORP" (live 2026-10-06)', async () => {
    assert.equal(looksLikeOrganization('Carlos Alberto Sosa Rosales'), false);
    assert.equal(looksLikeOrganization('Juan Diego Cedeno'), false);
    assert.equal(looksLikeOrganization('Miami Neurology & Rehab Specialists'), true);
    const corp = { number: '1619560547', enumeration_type: 'NPI-2', basic: { organization_name: 'CARLOS ALBERTO ALSINA MORFA APRN CORP' }, addresses: [{ address_purpose: 'LOCATION', postal_code: '331740000' }], taxonomies: [{ primary: true, desc: 'Clinic/Center' }] };
    const sosaClinic = { ...corp, number: '3333333333', basic: { organization_name: 'SOSA FAMILY MEDICAL CENTER' } };
    const saved = global.fetch;
    let orgs = [corp];
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      return { ok: true, json: async () => ({ results: q.get('enumeration_type') === 'NPI-2' ? orgs : [] }) };
    };
    try {
      const r = await resolveNpiRecords({ doctorName: 'Carlos Alberto Sosa Rosales', zip: '33172' });
      assert.deepEqual(r.map((x) => x.number), []);
      orgs = [corp, sosaClinic];
      const r2 = await resolveNpiRecords({ doctorName: 'Carlos Alberto Sosa Rosales', zip: '33172' });
      assert.deepEqual(r2.map((x) => x.number), ['3333333333']);
    } finally { global.fetch = saved; }
  });

  it('a case manager is never the doctor she named (Carlos Alberto Sosa Rosales, NPI 1922503820)', () => {
    const { isNonProvider } = require('./npiRegistry');
    assert.equal(isNonProvider({ basic: { first_name: 'CARLOS', last_name: 'SOSA ROSALES' }, taxonomies: [{ primary: true, desc: 'Case Management' }] }), true);
    assert.equal(isNonProvider(person('5', 'JOHN', 'A', 'MORYTKO', 'MD', '33136', 'Cardiovascular Disease')), false);
  });

  it('first name outranks ZIP; non-providers drop out', () => {
    const ranked = rankResults([
      person('1', 'AMANDA', '', 'SOSA', 'RBT', '33172', 'Behavior Technician'),
      person('2', 'CARLOS', '', 'SOSA', 'MD', '33010'),
    ], { zip: '33172', firstName: 'Carlos' });
    assert.equal(ranked[0].number, '2');
  });
});

describe('longer registered last names (Ian Del Conde → DEL CONDE POZZI)', () => {
  const { resolveNpiRecords } = require('./npiRegistry');
  it('finds Ian Del Conde Pozzi with a trailing-wildcard last name', async () => {
    const saved = global.fetch;
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      const last = (q.get('last_name') || '').toUpperCase();
      const first = (q.get('first_name') || '').toUpperCase();
      const rec = { number: '1649309139', basic: { first_name: 'IAN', last_name: 'DEL CONDE POZZI', credential: 'MD' }, addresses: [], taxonomies: [{ primary: true, desc: 'Cardiovascular Disease' }] };
      const hit = q.get('enumeration_type') === 'NPI-1' && first === 'IAN' && last === 'DEL CONDE*';
      return { ok: true, json: async () => ({ results: hit ? [rec] : [] }) };
    };
    try {
      const r = await resolveNpiRecords({ doctorName: 'Ian Del Conde', zip: '33172' });
      assert.equal(r[0] && r[0].number, '1649309139');
    } finally { global.fetch = saved; }
  });
});

describe('closest real providers when the name has no exact match', () => {
  const { suggestSimilarProviders } = require('./npiRegistry');
  it('Carlos Sosa → Sosa physicians near the client, no case managers or pharmacists', async () => {
    const saved = global.fetch;
    const rec = (npi, first, last, cred, zip, tax) => ({ number: npi, basic: { first_name: first, last_name: last, credential: cred }, addresses: [{ address_purpose: 'LOCATION', postal_code: zip, city: 'MIAMI' }], taxonomies: [{ primary: true, desc: tax }] });
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [
      rec('1922503820', 'CARLOS', 'SOSA ROSALES', '', '33010', 'Case Management'),
      rec('1063015568', 'DALBERT', 'SOSA', '', '33186', 'Pharmacist'),
      rec('1962865204', 'GLENDA', 'SOSA', 'M.D.', '33176', 'Internal Medicine, Nephrology'),
      rec('1902951742', 'ANDRES', 'SOSA', 'M.D.', '32801', 'Internal Medicine, Pulmonary Disease'),
    ] }) });
    try {
      const s = await suggestSimilarProviders({ doctorName: 'Carlos Sosa', zip: '33172' });
      assert.deepEqual(s.map((x) => x.npi), ['1962865204', '1902951742']);
      assert.equal(s[0].name, 'Glenda Sosa, MD');
    } finally { global.fetch = saved; }
  });
});

describe('compound names do not suggest people who share only the last word', () => {
  const { suggestSimilarProviders } = require('./npiRegistry');
  it('Carlos Alberto Sosa Rosales → no unrelated Rosales doctors; a Sosa Rosales relative still shows', async () => {
    const saved = global.fetch;
    const rec = (npi, first, middle, last, cred, zip, tax) => ({ number: npi, basic: { first_name: first, middle_name: middle, last_name: last, credential: cred }, addresses: [{ address_purpose: 'LOCATION', postal_code: zip, city: 'MIAMI' }], taxonomies: [{ primary: true, desc: tax }] });
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [
      rec('1111111111', 'JULIO', 'CESAR', 'ROSALES', 'MD', '33172', 'General Practice'),
      rec('2222222222', 'LEO', 'ELLIOT', 'ROSALES', 'MD', '33172', 'Internal Medicine, Hospitalist'),
      rec('3333333333', 'GABRIELLA', 'CRISTINA', 'ROSALES', 'NP', '33172', 'Nurse Practitioner, Family'),
      rec('4444444444', 'MARIA', '', 'SOSA ROSALES', 'MD', '33172', 'Family Medicine'),
      rec('5555555555', 'CARLOS', 'A', 'ROSALES', 'MD', '33172', 'Family Medicine'),
    ] }) });
    try {
      const s = await suggestSimilarProviders({ doctorName: 'Carlos Alberto Sosa Rosales', zip: '33172' });
      const npis = s.map((x) => x.npi);
      assert.ok(!npis.includes('1111111111') && !npis.includes('2222222222') && !npis.includes('3333333333'));
      assert.ok(npis.includes('4444444444'), 'shares Sosa Rosales');
      assert.ok(npis.includes('5555555555'), 'same first name');
    } finally { global.fetch = saved; }
  });
});

describe('spelling-tolerant suggestions', () => {
  const { suggestSimilarProviders, spellingDistance } = require('./npiRegistry');
  it('a swapped letter is one typo', () => {
    assert.equal(spellingDistance('Mortyko', 'Morytko'), 1);
    assert.equal(spellingDistance('Sosa', 'Sosa'), 0);
  });
  it('"John Mortyko" finds John A Morytko, MD and marks it as a spelling fix', async () => {
    const saved = global.fetch;
    const rec = (npi, first, middle, last, cred, zip, tax) => ({ number: npi, basic: { first_name: first, middle_name: middle, last_name: last, credential: cred }, addresses: [{ address_purpose: 'LOCATION', postal_code: zip, city: 'MIAMI' }], taxonomies: [{ primary: true, desc: tax }] });
    global.fetch = async (url) => {
      const q = new URL(url).searchParams;
      const last = (q.get('last_name') || '').toUpperCase();
      const first = (q.get('first_name') || '').toUpperCase();
      const dir = [
        rec('1356385736', 'JOHN', 'A', 'MORYTKO', 'MD', '33156', 'Internal Medicine, Cardiovascular Disease'),
        rec('1609315225', 'JOHN', '', 'MORTENSEN', 'BCaBA', '32073', 'Behavior Analyst'),
        rec('5555555555', 'MARIA', '', 'MORALES', 'MD', '33172', 'Family Medicine'),
      ];
      const hit = dir.filter((r) => {
        const L = r.basic.last_name;
        const okLast = last.endsWith('*') ? L.startsWith(last.slice(0, -1)) : L === last;
        return okLast && (!first || r.basic.first_name === first);
      });
      return { ok: true, json: async () => ({ results: hit }) };
    };
    try {
      const s = await suggestSimilarProviders({ doctorName: 'John Mortyko', zip: '33172' });
      assert.equal(s[0].npi, '1356385736');
      assert.equal(s[0].spelling, true);
      assert.ok(!s.some((x) => x.npi === '1609315225'), 'behavior analyst is not a doctor');
      assert.ok(!s.some((x) => x.npi === '5555555555'), 'Maria Morales is not a misspelling of John Mortyko');
    } finally { global.fetch = saved; }
  });
});
