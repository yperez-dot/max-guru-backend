// Dentists are checked in each plan's dental network, never the medical directories (Gerry Cabrera, 2026-10-19).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const D = require('./dentalDirectory');

const FRAGA = { npi: '1205322856', firstName: 'SALOME', lastName: 'FRAGA', name: 'SALOME FRAGA DMD' };

/** fetch stub: route(url, options) → { status, body, headers } */
function stubFetch(route) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const r = await route(String(url), opts);
    const headers = new Map(Object.entries(r.headers || {}));
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null, getSetCookie: () => r.cookies || [] },
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    };
  };
  fn.calls = calls;
  return fn;
}

const humanaRow = (npi) => ({
  providerName: 'Fraga, Salome DMD', affiliationNames: 'Pinecrest Dentistry PA', phone: '(305) 330-9882', officeDistance: 4.27,
  nationalProviderIdentifiers: [npi], address: { addressLine1: '13623 S Dixie Hwy', addressLine2: 'Ste 147', city: 'Miami', stateCode: 'FL', zipCode: '33176' },
});
function humanaRoute(results) {
  return (url, opts) => {
    if (url.endsWith('/session/v1/config')) return { body: { APIM_SUBSCRIPTION: 'public-key' } };
    if (url.includes('/token/validate/guest')) return { body: {} };
    if (url.includes('/providersearch/npi/')) return typeof results === 'function' ? results(JSON.parse(opts.body)) : { body: { resultCount: results.length, results } };
    return { status: 404, body: {} };
  };
}
function uhcRoute(providers) {
  return (url) => {
    if (url.includes('create-guest-session') || url.includes('authorize-guest-session')) return { body: { authorized: true } };
    if (url.endsWith('/api/graphql')) return typeof providers === 'function' ? providers() : { body: { data: { providerSearch: { providers } } } };
    return { status: 404, body: {} };
  };
}
const fdbRows = [
  { slug: 'terrace-dental-care-1982957312-11694-814741590-ryan-mcfadden-doctors-healthcare-plans', provider_full_name: 'Ryan McFadden, DMD', office_name: 'Terrace Dental Care', street: '5411 E Busch Blvd', city: 'Tampa', zip: '33617', latitude: '28.03', longitude: '-82.39', phone: '' },
  { slug: 'gv-dental-studio-1234567890-1-2-gielen-valdes-perez-doctors-healthcare-plans', provider_full_name: 'Gielen Valdes Perez, DDS', office_name: 'GV Dental Studio Corp', street: '1 Main', city: 'Miami', zip: '33186', latitude: '25.66', longitude: '-80.40', phone: '' },
];
function fdbRoute(pages) {
  return (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return { body: pages[page - 1] || [], headers: { 'x-wp-totalpages': String(pages.length) } };
  };
}

beforeEach(() => D.resetDentalCaches());

describe('who is a dentist', () => {
  it('taxonomy 1223* or a DDS / DMD credential', () => {
    assert.equal(D.isDentistRecord({ taxonomies: [{ code: '1223G0001X', desc: 'Dentist, General Practice', primary: true }] }), true);
    assert.equal(D.isDentistRecord({ basic: { credential: 'D.M.D.' }, taxonomies: [] }), true);
    assert.equal(D.isDentistRecord({ basic: { credential: 'DDS' } }), true);
    assert.equal(D.isDentistRecord({ basic: { credential: 'MD' }, taxonomies: [{ code: '207R00000X', desc: 'Internal Medicine', primary: true }] }), false);
  });
  it('a dental ask', () => {
    assert.equal(D.asksForDentist('Pinecrest Modern Dentistry'), true);
    assert.equal(D.asksForDentist('Elvin Silvestry DDS'), true);
    assert.equal(D.asksForDentist('Alix Salvant'), false);
  });
});

describe('plan → dental network (data/dental-networks-2027.json)', () => {
  const dental = { isDentist: true, sources: { 'humana:3171': { status: 'in' }, 'uhc:national': { status: 'out' }, 'fdb:41': { status: 'out' }, 'fdb:45': { status: 'failed' } } };
  const cases = {
    'H1036-054C': '✅ In', // Humana Gold Plus → Florida Gold Plus Dental
    'H1019-150': '✅ In', // CarePlus → Florida Gold Plus Dental (Humana)
    'H1889-002': '❌ Not in network (not listed)', // UHC Dual Complete → UHC National MA dental
    'R0759-001': '❌ Not in network (not listed)', // AARP UHC
    'H4140-022': '❌ Not in network (not listed)', // Doctors HCP → FDB
    'H5431-001': '❔ not confirmed', // HealthSun FDB errored → never Out
    'H5420-001': '❔ check dental directory (Solstice)', // MedicareMax = Preferred Care Network
    'H1045-001': '❔ check dental directory (Solstice)', // Preferred Care Partners
    'H1290-001': 'ℹ️ no dental network (reimbursed)', // Devoted
    'H0982-002': '❔ check dental directory (DentaQuest)', // Solis
    'H1609-093': '❔ check dental directory (Liberty for HMO, Aetna Dental for PPO)',
    'H1032-195': '❔ check dental directory (Liberty Dental 888-352-0225)',
    'H5471-125': '❔ check dental directory (Liberty)',
    'H1035-017': '❔ check dental directory (Florida Blue Dental)',
  };
  for (const [id, want] of Object.entries(cases)) {
    it(`${id} → ${want}`, () => assert.equal(D.dentalCell(dental, id), want));
  }
  it('HealthSpring (by carrier name) → no dental network', () => assert.equal(D.dentalCell(dental, 'H9999-001', 'HealthSpring'), 'ℹ️ no dental network (reimbursed)'));
  it('an unknown plan is never Out', () => assert.match(D.dentalCell(dental, 'H9999-001'), /^❔ check dental directory/));
  it('no lookup ran → check dental directory, never Out', () => assert.equal(D.dentalCell(undefined, 'H1036-054C'), '❔ check dental directory (Florida Gold Plus Dental (Humana))'));
  it('cellsByContract covers every configured contract', () => {
    const m = D.dentalCellsByContract(dental);
    assert.equal(m.H1036, '✅ In');
    assert.equal(m.H5420, '❔ check dental directory (Solstice)');
    assert.equal(m.H1290, 'ℹ️ no dental network (reimbursed)');
  });
});

describe('Humana dental (Find Care, customerId 1004, network 3171)', () => {
  it('listed by NPI → In, with the office', async () => {
    let body;
    const f = stubFetch(humanaRoute((b) => { body = b; return { body: { resultCount: 1, results: [humanaRow('1205322856')] } }; }));
    const r = await D.searchHumanaDental({ npi: '1205322856', zip: '33186', networkId: 3171 }, f);
    assert.equal(r.status, 'in');
    assert.match(r.match.address, /13623 S Dixie Hwy/);
    assert.equal(body.customerId, 1004);
    assert.equal(body.networkId, 3171);
    assert.equal(body.coverageTypeId, 7);
    assert.ok(f.calls.some((c) => c.opts.headers && c.opts.headers['X-Fc-Module'] === 'dental'));
  });
  it('a successful empty search → Out', async () => {
    const r = await D.searchHumanaDental({ npi: '1205322856', zip: '33186', networkId: 3171 }, stubFetch(humanaRoute([])));
    assert.equal(r.status, 'out');
  });
  it('a non-search 200 is a failure, never a miss', async () => {
    await assert.rejects(D.searchHumanaDental({ npi: '1', zip: '33186', networkId: 3171 }, stubFetch(humanaRoute(() => ({ body: {} })))));
  });
});

describe('UHC dental (guest Find a Doctor, coverage type D)', () => {
  it('National MA network lists the NPI → In; query is dental', async () => {
    const f = stubFetch(uhcRoute([{ firstName: 'Ronald', lastName: 'Schram', npi: '1891290615', speciality: 'General Dentist' }]));
    const r = await D.searchUhcDental({ npi: '1891290615', zip: '33186' }, f);
    assert.equal(r.status, 'in');
    const g = JSON.parse(f.calls.find((c) => c.url.endsWith('/api/graphql')).opts.body);
    assert.equal(g.variables.coverageType, 'D');
    assert.equal(g.variables.reciprocityId, 'FFS000000028');
  });
  it('empty list → Out; GraphQL error → failure', async () => {
    assert.equal((await D.searchUhcDental({ npi: '1205322856', zip: '33186' }, stubFetch(uhcRoute([])))).status, 'out');
    D.resetDentalCaches();
    await assert.rejects(D.searchUhcDental({ npi: '1', zip: '33186' }, stubFetch(uhcRoute(() => ({ body: { errors: [{ message: '400: Bad Request' }] } })))));
  });
});

describe('Florida Dental Benefits (GeoDirectory REST, cached daily)', () => {
  it('NPI from the slug', () => assert.equal(D.fdbNpi(fdbRows[0].slug), '1982957312'));
  it('matches by NPI, then by name near her ZIP; loads every page once', async () => {
    const f = stubFetch(fdbRoute([[fdbRows[0]], [fdbRows[1]]]));
    const byNpi = await D.searchFdb({ npi: '1982957312', zip: '33186', category: 41 }, f);
    assert.equal(byNpi.status, 'in');
    const byName = await D.searchFdb({ npi: '0000000000', firstName: 'Gielen', lastName: 'Valdes Perez', zip: '33186', category: 41 }, f);
    assert.equal(byName.status, 'in');
    assert.equal(byName.matchedBy, 'name');
    const miss = await D.searchFdb({ ...FRAGA, zip: '33186', category: 41 }, f);
    assert.equal(miss.status, 'out');
    assert.equal(f.calls.length, 2, 'two pages, fetched once, cached');
    assert.match(f.calls[0].url, /gd_placecategory=41/);
  });
  it('a same-name dentist far away (Tampa) is not her dentist', async () => {
    const f = stubFetch(fdbRoute([[fdbRows[0]]]));
    const r = await D.searchFdb({ npi: '0000000000', firstName: 'Ryan', lastName: 'McFadden', zip: '33186', category: 41 }, f);
    assert.equal(r.status, 'out');
  });
  it('the list failing to load is a failure (not confirmed), never Out', async () => {
    await assert.rejects(D.searchFdb({ ...FRAGA, zip: '33186', category: 45 }, stubFetch(() => ({ status: 500, body: {} }))));
  });
});

describe('checkDentist: every source, own timeouts, errors → failed', () => {
  it('Fraga: Humana In, UHC Out, FDB Out; a dead source is failed', async () => {
    const route = (url, opts) => {
      if (url.startsWith('https://findcare.humana.com')) return humanaRoute([humanaRow('1205322856')])(url, opts);
      if (url.startsWith('https://findcare.guest.uhc.com')) return uhcRoute([])(url, opts);
      if (url.includes('gd_placecategory=41')) return fdbRoute([fdbRows])(url);
      return { status: 503, body: {} };
    };
    const r = await D.checkDentist(FRAGA, { zip: '33186', fetchImpl: stubFetch(route) });
    assert.equal(r.sources['humana:3171'].status, 'in');
    assert.equal(r.sources['uhc:national'].status, 'out');
    assert.equal(r.sources['fdb:41'].status, 'out');
    assert.equal(r.sources['fdb:45'].status, 'failed');
    assert.equal(r.cellsByContract.H1036, '✅ In');
    assert.equal(r.cellsByContract.H4140, '❌ Not in network (not listed)');
    assert.equal(r.cellsByContract.H5431, '❔ not confirmed');
    assert.match(D.formatDentalText('Salome Fraga', FRAGA, r), /Florida Gold Plus Dental.*LISTED/);
  });
  it('a hung source times out as failed (bounded by the deadline)', async () => {
    const hang = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await D.checkDentist(FRAGA, { zip: '33186', fetchImpl: hang, deadlineAt: Date.now() + 1200, only: ['uhc:national'] });
    assert.equal(r.sources['uhc:national'].status, 'failed');
    assert.ok(Date.now() - t0 < 3000);
  });
});

describe('providerNetwork: a dentist gets dental checks only', () => {
  it('npiRecordInfo flags dentists; dentalDoctorResult carries no medical In/Out', async () => {
    const P = require('./providerNetwork');
    const rec = P.npiRecordInfo({ number: '1205322856', enumeration_type: 'NPI-1', basic: { first_name: 'SALOME', last_name: 'FRAGA', credential: 'DMD' }, taxonomies: [{ code: '1223G0001X', desc: 'Dentist, General Practice', primary: true }], addresses: [] });
    assert.equal(rec.isDentist, true);
    const r = await P.dentalDoctorResult('Salome Fraga', rec, { zip: '33186', planYear: 2027, checkDentist: async () => ({ isDentist: true, sources: { 'humana:3171': { status: 'in' } }, cellsByContract: {} }) });
    assert.equal(r.status, 'done');
    assert.equal(r.structured.isDentist, true);
    assert.deepEqual(r.structured.outOfNetworkPlans, []);
    assert.deepEqual(r.structured.networks, []);
    const failed = await P.dentalDoctorResult('Salome Fraga', rec, { zip: '33186', checkDentist: async () => { throw new Error('down'); } });
    assert.equal(failed.structured.dental.cellsByContract.H1036, '❔ not confirmed');
  });
});

describe('grid: dentist cells, counts and ranking', () => {
  const N = require('./doctorPlanNarrow');
  const dentist = (sources) => {
    const dental = { isDentist: true, sources };
    dental.cellsByContract = D.dentalCellsByContract(dental);
    return { doctorName: 'SALOME FRAGA DMD', requestedName: 'Salome Fraga', npi: '1205322856', status: 'done', isDentist: true, dental, inNetworkPlans: [], outOfNetworkPlans: [], networks: [], carriersIn: [], pending: [], failed: [] };
  };
  const md = (name, inPlans) => ({ doctorName: name, requestedName: name, npi: '1588693477', status: 'done', inNetworkPlans: inPlans, outOfNetworkPlans: [], networks: [], carriersIn: [], pending: [], failed: [] });
  const plans = [{ planId: 'H1036-054C', name: 'Humana Gold Plus' }, { planId: 'H4140-022', name: 'Doctors DrMax-Dade' }, { planId: 'H5420-001', name: 'UHC MedicareMax FL-0028' }];
  it('dentist row reads the dental networks and is in no column list or count', () => {
    const docs = [md('Alix Salvant', ['Humana Gold Plus (H1036-054C)', 'Doctors DrMax-Dade (H4140-022)', 'UHC MedicareMax FL-0028 (H5420-001)']), dentist({ 'humana:3171': { status: 'in' }, 'fdb:41': { status: 'out' } })];
    const cols = N.namedPlanColumns(plans, [], docs);
    for (const c of cols) {
      assert.deepEqual(c.dental, ['Salome Fraga']);
      assert.ok(![...c.in, ...c.out, ...c.unknown].includes('Salome Fraga'));
    }
    const t = N.gridTable(docs, cols);
    const row = t.split('\n').find((l) => /Fraga/.test(l));
    assert.match(row, /\| ✅ In \| ❌ Not in network \(not listed\) \| ❔ check dental directory \(Solstice\) \|/);
    assert.match(t, /\*\*1 in · 0 not in network · 0 unchecked\*\*/);
  });
  it('a ❔ dental cell does not trigger "No single plan has all the doctors"', () => {
    const all = ['Humana Gold Plus (H1036-054C)', 'Doctors DrMax-Dade (H4140-022)'];
    const meds = [md('Alix Salvant', all), { ...md('Ignacio Rua', all), npi: '1235132549' }, { ...md('Martin Madorsky', all), npi: '1477526671' }];
    const mustKeep = (docs) => (N.selectComparison(docs, 'ZIP 33186.', {}).questions || []).some((q) => /No single plan has all/i.test(q));
    // Control: a 4th medical doctor on no plan does trigger the question …
    assert.equal(mustKeep([...meds, { ...md('Robert Puig', []), npi: '1568433308' }]), true);
    // … a dentist (whatever the dental cells say) does not.
    assert.equal(mustKeep([...meds, dentist({ 'humana:3171': { status: 'out' } })]), false);
    assert.equal(mustKeep([...meds, dentist({})]), false);
  });
});

describe('npiRegistry.isTreating keeps dentists for a dental ask', () => {
  const { isTreating } = require('./npiRegistry');
  const fraga = { basic: { first_name: 'SALOME', last_name: 'FRAGA', credential: 'DMD' }, taxonomies: [{ desc: 'Dentist, General Practice', primary: true }] };
  it('medical ask drops a dentist; dental ask keeps one', () => {
    assert.equal(isTreating(fraga), false);
    assert.equal(isTreating(fraga, { dental: true }), true);
    assert.equal(isTreating({ basic: { credential: 'RBT' }, taxonomies: [{ desc: 'Behavior Technician' }] }, { dental: true }), false);
  });
});

describe('export: dentist cells = the chat grid words', () => {
  const E = require('../artifacts/comparison-export.js');
  const plans = [{ planId: 'H5420-001', carrier: 'UHC', planName: 'UHC MedicareMax FL-0028' }, { planId: 'H4140-022', carrier: 'Doctors', planName: 'Doctors DrMax-Dade' }, { planId: 'H1036-054C', carrier: 'Humana', planName: 'Humana Gold Plus' }, { planId: 'H1290-001', carrier: 'Devoted', planName: 'Devoted CORE 001' }];
  it('from the lookups (dental.cellsByContract) and from the chat table', () => {
    const dental = { isDentist: true, sources: { 'humana:3171': { status: 'in' }, 'fdb:41': { status: 'out' } } };
    dental.cellsByContract = D.dentalCellsByContract(dental);
    const tool = { tool: 'lookup_provider_network', output: { doctorName: 'SALOME FRAGA DMD', requestedName: 'Salome Fraga', npi: '1205322856', status: 'done', isDentist: true, dental, networks: [] } };
    const want = ['Check dental directory (Solstice)', 'Not in network (not listed)', 'In network', 'No dental network (reimbursed)'];
    const m1 = E.buildComparisonModel(E.buildExportPayload(plans, '', { planSetFixed: true, toolResults: [tool], drugs: [] }));
    assert.deepEqual(m1.aoa.find((r) => /Fraga/.test(r[0])).slice(1), want);
    const table = ['| Doctor | UHC · H5420-001 | DrMax · H4140-022 | Humana · H1036-054C | Devoted · H1290-001 |', '|---|---|---|---|---|',
      '| Salome Fraga · NPI 1205322856 | ❔ check dental directory (Solstice) | ❌ Not in network (not listed) | ✅ In | ℹ️ no dental network (reimbursed) |'].join('\n');
    const m2 = E.buildComparisonModel(E.buildExportPayload(plans, table, { chatTable: E.latestChatTable([{ role: 'assistant', content: table }]), planSetFixed: true, doctors: [], drugs: [] }));
    assert.deepEqual(m2.aoa.find((r) => /Fraga/.test(r[0])).slice(1), want);
  });
});
