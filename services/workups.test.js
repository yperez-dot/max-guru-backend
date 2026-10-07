const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkupStore, slimMedications } = require('../services/workups');
const workupsUi = require('../artifacts/client-workups.js');
const exp = require('../artifacts/comparison-export.js');

function tempStore(maxPerOwner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-workups-'));
  const store = new WorkupStore({
    filePath: path.join(dir, 'workups.json'),
    maxPerOwner: maxPerOwner || 50,
  });
  return {
    store,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function muskatPayload() {
  return {
    clientName: 'Muskat',
    zip: '33176',
    county: 'Miami-Dade',
    contacts: '305-555-0100',
    terminatingPlan: 'Humana Gold Plus HMO',
    needs: ['keep PCP', 'dual SNP'],
    plans: [
      { planId: 'H1036-054C', planName: 'Gold Plus', carrier: 'Humana', county: 'Miami-Dade', premium: '$0', tier4: 0.4 },
      { planId: 'H1045-012', planName: 'Dual Complete FL-D001', carrier: 'UHC Preferred', county: 'Miami-Dade', premium: '$0' },
    ],
    doctors: [
      {
        name: 'Dr. Garcia',
        statuses: ['In network', 'Out of network'],
      },
      {
        name: 'MNRS',
        byPlanId: { 'H1036-054C': 'NEED MORE INFO', 'H1045-012': 'NOT CONFIRMED' },
      },
    ],
    drugs: [
      {
        name: 'Trintellix',
        claimedTier: 4,
        byPlanId: {
          'H1036-054C': { verified: true, tier: 5, costShare: '33%', source: 'sunfire' },
          'H1045-012': { verified: false, tier: 4 },
        },
      },
      { name: 'Lorazepam', claimedTier: 2, byPlanId: { 'H1036-054C': { verified: false, tier: 2 } } },
    ],
    messages: [{ role: 'user', content: 'paste of the entire Daisy brief '.repeat(50) }],
    transcript: 'full chat',
  };
}

describe('workup store identity + shape', () => {
  it('scopes lists by unlock email and never keeps Daisy tiers or transcripts', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const yahoska = store.upsert('yperez@healthexps.com', muskatPayload());
    store.upsert('carolina@healthexps.com', { clientName: 'Carol Wong', plans: muskatPayload().plans });

    assert.equal(yahoska.clientName, 'Muskat');
    assert.equal(yahoska.zip, '33176');
    assert.equal(yahoska.ownerEmail, 'yperez@healthexps.com');
    assert.equal(yahoska.messages, undefined);
    assert.equal(yahoska.transcript, undefined);
    assert.equal(yahoska.plans[0].premium, undefined);
    const trin = yahoska.medications.find((d) => d.name === 'Trintellix');
    assert.ok(trin);
    assert.equal(trin.claimedTier, undefined);
    assert.equal(trin.byPlanId['H1036-054C'].tier, 5);
    assert.equal(trin.byPlanId['H1045-012'], undefined);
    assert.equal(yahoska.medications.some((d) => d.name === 'Lorazepam'), false);
    assert.equal(yahoska.doctors[0].byPlanId['H1036-054C'], 'IN');
    assert.equal(yahoska.doctors[1].byPlanId['H1036-054C'], 'NEED MORE INFO');

    const yList = store.list('yperez@healthexps.com');
    const cList = store.list('carolina@healthexps.com');
    assert.equal(yList.length, 1);
    assert.equal(yList[0].clientName, 'Muskat');
    assert.equal(cList.length, 1);
    assert.equal(cList[0].clientName, 'Carol Wong');
    assert.equal(store.get('carolina@healthexps.com', yahoska.id), null);
  });

  it('caps each owner at 50 and updates the same client name in place', (t) => {
    const { store, cleanup } = tempStore(50);
    t.after(cleanup);
    for (let i = 0; i < 55; i += 1) {
      store.upsert('krobles@healthexps.com', {
        clientName: `Client ${i}`,
        plans: [
          { planId: 'H1036-054C', planName: 'Gold Plus' },
          { planId: 'H1045-012', planName: 'Dual' },
        ],
      });
    }
    assert.equal(store.list('krobles@healthexps.com').length, 50);
    store.upsert('krobles@healthexps.com', {
      clientName: 'Client 54',
      zip: '33010',
      plans: [
        { planId: 'H1036-054C', planName: 'Gold Plus' },
        { planId: 'H1045-012', planName: 'Dual' },
      ],
    });
    const hit = store.list('krobles@healthexps.com').find((w) => w.clientName === 'Client 54');
    assert.equal(hit.zip, '33010');
    assert.equal(store.list('krobles@healthexps.com').filter((w) => w.clientName === 'Client 54').length, 1);
  });

  it('slimMedications drops claimedTier even when verified is missing', () => {
    const slim = slimMedications([
      { name: 'Atorvastatin', claimedTier: 1, byPlanId: { 'H1036-054C': { verified: false, tier: 1 } } },
    ]);
    assert.deepEqual(slim, []);
  });

  it('rejects empty saves and delete is owner-scoped', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    assert.throws(() => store.upsert('yperez@healthexps.com', { clientName: '', plans: [] }), /2\+ plans/);
    const saved = store.upsert('yperez@healthexps.com', muskatPayload());
    store.upsert('carolina@healthexps.com', { clientName: 'Carol Wong', plans: muskatPayload().plans });
    assert.equal(store.delete('carolina@healthexps.com', saved.id), false);
    assert.ok(store.get('yperez@healthexps.com', saved.id));
    assert.equal(store.delete('yperez@healthexps.com', saved.id), true);
    assert.equal(store.get('yperez@healthexps.com', saved.id), null);
    assert.equal(store.list('carolina@healthexps.com').length, 1);
  });
});

describe('server wiring', () => {
  it('mounts /workups behind requireApiKey and requireAccessToken', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(src, /app\.use\('\/workups', requireApiKey, requireAccessToken, workupsRouter\)/);
  });
});

describe('compact resume context', () => {
  it('builds a short workup context without Daisy tiers or transcripts', () => {
    const payload = exp.buildExportPayload(
      muskatPayload().plans,
      'Compare H1036-054C and H1045-012 for Muskat in Miami-Dade 33176. Needs: keep PCP; dual SNP. Meds from Daisy: Trintellix T4.',
      {
        clientName: 'Muskat',
        doctors: muskatPayload().doctors,
        drugs: muskatPayload().drugs,
        skipMuskatLock: true,
      }
    );
    const workup = workupsUi.buildWorkupFromExport(payload, {
      threadText: 'Client: Muskat\nZIP 33176 Miami-Dade\nNeeds: keep PCP; dual SNP\nContacts: 305-555-0100',
      terminatingPlan: 'Humana Gold Plus HMO',
    });
    assert.equal(workup.clientName, 'Muskat');
    assert.equal(workup.zip, '33176');
    assert.equal(workup.medications[0].byPlanId['H1036-054C'].tier, 5);
    assert.equal(JSON.stringify(workup).includes('Tier 4'), false);
    assert.equal(JSON.stringify(workup).includes('claimedTier'), false);
    const compact = workupsUi.compactWorkupContext(workup);
    assert.match(compact, /LOADED CLIENT WORKUP/);
    assert.match(compact, /Do not lock the export to this snapshot/);
    assert.match(compact, /NEW request/);
    assert.match(compact, /Muskat/);
    assert.match(compact, /33176/);
    assert.match(compact, /Tier 5/);
    assert.equal(compact.includes('Daisy: Trintellix T4'), false);
    assert.ok(compact.length < 2500);
    const prior = [
      { role: 'user', content: 'here is the entire brief again '.repeat(80) },
      { role: 'assistant', content: 'long prior answer '.repeat(80) },
    ];
    const apiMsgs = workupsUi.messagesForApi([], workup);
    assert.equal(apiMsgs.length, 1);
    assert.equal(apiMsgs[0].role, 'user');
    assert.ok(apiMsgs[0].content.length < 2500);
    const continued = workupsUi.messagesForApi([{ role: 'user', content: 'Is MNRS in on Humana?' }], workup);
    assert.equal(continued.length, 2);
    assert.equal(continued[0].content, compact);
    assert.equal(continued[1].content, 'Is MNRS in on Humana?');
    assert.equal(workupsUi.messagesForApi(prior, null).length, 2);
  });

  it('parses a labeled client name from the thread when the export payload is unnamed', () => {
    const payload = {
      plans: [
        { planId: 'H4140-001', planName: 'Doctors MedicareMax', carrier: 'Doctors', county: 'Miami-Dade' },
        { planId: 'H1036-305', planName: 'Gold Plus', carrier: 'Humana', county: 'Miami-Dade' },
      ],
      clientName: '',
    };
    const unnamed = workupsUi.buildWorkupFromExport(payload, { threadText: 'Compare H4140-001 and H1036-305 in Miami-Dade' });
    assert.equal(unnamed.clientName, '');
    assert.equal(workupsUi.workupListLabel(unnamed), 'Unnamed — H4140-001 / H1036-305');

    const fromThread = workupsUi.buildWorkupFromExport(payload, {
      threadText: 'Clients name is Muskat\nCan u check his drs on United?',
    });
    assert.equal(fromThread.clientName, 'Muskat');
    assert.equal(workupsUi.workupListLabel(fromThread), 'Muskat');

    const keepSaved = workupsUi.buildWorkupFromExport(
      { plans: payload.plans, clientName: 'Muskat' },
      { threadText: 'Can u check his drs on United?' }
    );
    assert.equal(keepSaved.clientName, 'Muskat');

    const newerLabel = workupsUi.buildWorkupFromExport(
      { plans: payload.plans, clientName: 'Muskat' },
      { threadText: 'Client name is Felix Muskat' }
    );
    assert.equal(newerLabel.clientName, 'Felix Muskat');
  });

  it('rehydrates export payload so Excel still has plan columns', () => {
    const catalog = [
      { planId: 'H1036-054C', planName: 'Gold Plus', carrier: 'Humana', county: 'Miami-Dade', premium: 0, specialistCopay: 20 },
      { planId: 'H1045-012-000', planName: 'Dual Complete FL-D001', carrier: 'UHC Preferred', county: 'Miami-Dade', premium: 0 },
    ];
    const workup = workupsUi.buildWorkupFromExport({
      clientName: 'Muskat',
      plans: muskatPayload().plans,
      doctors: [{ name: 'Dr. Garcia', statuses: ['In network', 'Out of network'] }],
      drugs: muskatPayload().drugs,
    }, {});
    const exportPayload = workupsUi.workupToExportPayload(workup, catalog);
    assert.equal(exportPayload.plans[0].specialistCopay, 20);
    const model = exp.buildComparisonModel(exportPayload);
    assert.equal(model.title, 'Muskat');
    assert.ok(model.aoa.some((row) => row[0] === 'Dr. Garcia'));
    assert.ok(model.aoa.some((row) => row[0] === 'Trintellix'));
  });
});

describe('workup rename (tab menu)', () => {
  it('renames only the name and keeps it through later autosaves', () => {
    const { store, cleanup } = tempStore();
    try {
      const saved = store.upsert('agent@healthexps.com', muskatPayload());
      const renamed = store.rename('agent@healthexps.com', saved.id, 'Muskat — Bernard & Ruth');
      assert.equal(renamed.clientName, 'Muskat — Bernard & Ruth');
      assert.equal(renamed.nameLocked, true);
      assert.deepEqual(renamed.planIds, saved.planIds);
      assert.equal(renamed.zip, saved.zip);

      // Autosave from chat re-extracts "Muskat" — the typed name must win.
      const again = store.upsert('agent@healthexps.com', { ...muskatPayload(), id: saved.id });
      assert.equal(again.clientName, 'Muskat — Bernard & Ruth');
      assert.equal(store.list('agent@healthexps.com')[0].clientName, 'Muskat — Bernard & Ruth');
    } finally {
      cleanup();
    }
  });

  it('rejects an empty name and unknown ids, and only touches the owner list', () => {
    const { store, cleanup } = tempStore();
    try {
      const saved = store.upsert('agent@healthexps.com', muskatPayload());
      assert.throws(() => store.rename('agent@healthexps.com', saved.id, '   '), /empty/);
      assert.equal(store.rename('agent@healthexps.com', 'nope-nope-nope', 'X'), null);
      assert.equal(store.rename('other@healthexps.com', saved.id, 'X'), null);
    } finally {
      cleanup();
    }
  });
});

describe('compareResult', () => {
  it('is kept on save and survives a later re-save without one', () => {
    const { store, cleanup } = tempStore();
    const w = store.upsert('a@b.com', { clientName: 'Ana Perez', plans: [], compareResult: { doctorTable: '| a |', questions: ['q1'] } });
    assert.deepEqual(w.compareResult.questions, ['q1']);
    const again = store.upsert('a@b.com', { id: w.id, clientName: 'Ana Perez', plans: [] });
    assert.deepEqual(again.compareResult.questions, ['q1']);
    assert.equal(store.get('a@b.com', w.id).compareResult.doctorTable, '| a |');
    cleanup();
  });
});

describe('saved workup context keeps doctor names clean', () => {
  const { compactWorkupContext } = workupsUi;
  const { stripSavedStatus: cleanDoctorQuery } = require('./providerNetwork');
  it('lists names alone, and puts saved results in a separate [saved: …] block', () => {
    const text = compactWorkupContext({ clientName: 'Marilyn Butler', doctors: [{ name: 'Ashwin Mehta', byPlanId: { 'H1045-005': 'IN' } }, { name: 'Jorge G. Ruiz', byPlanId: {} }] });
    assert.match(text, /Doctors \(names only[^)]*\): Ashwin Mehta; Jorge G\. Ruiz/);
    assert.match(text, /- Ashwin Mehta \[saved: H1045-005 IN\]/);
    assert.doesNotMatch(text, /Ashwin Mehta: H1045-005/);
  });
  it('a pasted saved-result line still looks up just the name', () => {
    assert.equal(cleanDoctorQuery('Ashwin Mehta: H1045-005 IN'), 'Ashwin Mehta');
    assert.equal(cleanDoctorQuery('- Ruiz: H1036-305 OUT'), 'Ruiz');
    assert.equal(cleanDoctorQuery('Jorge G. Ruiz [saved: H1045-005 IN]'), 'Jorge G. Ruiz');
    assert.equal(cleanDoctorQuery('Jorge G. Ruiz'), 'Jorge G. Ruiz');
  });
});
