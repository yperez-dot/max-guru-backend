const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HN = require('./hospitalNetworks');

const humana = { carrier: 'Humana', planId: 'H1036-054C', name: 'Humana Gold Plus', type: 'HMO' };
const flBlue = { carrier: 'Florida Blue', planId: 'H1035-017', name: 'Florida Blue Medicare HMO' };
const healthSun = { carrier: 'HealthSun', planId: 'H5431-006', name: 'HealthSun MediMax' };
const simply = { carrier: 'Simply', planId: 'H5471-125', name: 'Simply Complete Platinum', type: 'D-SNP' };
const medicareMax = { carrier: 'UnitedHealthcare', planId: 'H5420-001', name: 'UHC MedicareMax FL-0028' };
const aetnaHmo = { carrier: 'Aetna', planId: 'H1609-093', name: 'Aetna Medicare Select', type: 'HMO' };
const aetnaPpo = { carrier: 'Aetna', planId: 'H5521-306', name: 'Aetna Medicare Premier PPO', type: 'PPO' };
const humanaPpo = { carrier: 'Humana', planId: 'H7617-107', name: 'HumanaChoice', type: 'PPO' };

describe('Hospitals x Carrier 2027 JSON', () => {
  it('has Baptist PCPs and UM PCP rows with Yahoska\'s Yes/No', () => {
    const baptist = HN.rowByName('Baptist PCPs');
    const um = HN.rowByName('UM PCP');
    assert.equal(baptist.kind, 'pcp');
    assert.equal(um.kind, 'pcp');
    assert.deepEqual(HN.yesCarriers('Baptist PCPs').sort(), ['FL BLUE', 'MedicareMax']);
    assert.deepEqual(HN.yesCarriers('UM PCP').sort(), ['HealthSun', 'Simply']);
    assert.equal(HN.rowByName('Baptist Hospital').kind, 'hospital');
    assert.equal(HN.rowByName('University of Miami').kind, 'hospital');
  });
});

describe('2027 PCP rows (Yahoska, Hospitals x Carrier tab)', () => {
  it('Humana → Baptist PCP No, UM PCP No (hospital still Yes at UM)', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', humana), false);
    assert.equal(HN.pcpIn('UM PCP', humana), false);
    assert.equal(HN.inNetwork('University of Miami', humana), true);
    assert.equal(HN.inNetwork('Baptist Hospital', humana), true);
  });

  it('FL BLUE → Baptist PCP Yes; UM PCP No', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', flBlue), true);
    assert.equal(HN.pcpIn('UM PCP', flBlue), false);
    assert.equal(HN.hospitalColumnFor(flBlue), 'FL BLUE');
  });

  it('HealthSun → UM PCP Yes; Baptist PCP No', () => {
    assert.equal(HN.pcpIn('UM PCP', healthSun), true);
    assert.equal(HN.inNetwork('University of Miami', healthSun), true);
    assert.equal(HN.pcpIn('Baptist PCPs', healthSun), false);
  });

  it('Simply → UM PCP Yes; Baptist PCP No', () => {
    assert.equal(HN.pcpIn('UM PCP', simply), true);
    assert.equal(HN.inNetwork('University of Miami', simply), true);
    assert.equal(HN.pcpIn('Baptist PCPs', simply), false);
  });

  it('MedicareMax → Baptist PCP Yes; UM PCP No; UM hospital No', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', medicareMax), true);
    assert.equal(HN.pcpIn('UM PCP', medicareMax), false);
    assert.equal(HN.inNetwork('University of Miami', medicareMax), false);
    assert.equal(HN.inNetwork('Baptist Hospital', medicareMax), true);
  });

  it('Aetna 2027 (HMO and PPO) → Baptist PCP No', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', aetnaHmo), false);
    assert.equal(HN.pcpIn('Baptist PCPs', aetnaPpo), false);
    assert.equal(HN.hospitalColumnFor(aetnaHmo), 'Aetna');
    assert.equal(HN.hospitalColumnFor(aetnaPpo), 'Aetna PPO');
  });

  it('Humana PPO is the Humana PPO column, not Humana HMO', () => {
    assert.equal(HN.hospitalColumnFor(humanaPpo), 'Humana PPO');
    assert.equal(HN.pcpIn('Baptist PCPs', humanaPpo), false);
    assert.equal(HN.pcpIn('UM PCP', humanaPpo), false);
  });
});

describe('PCP vs hospital row choice', () => {
  it('PCP asks hit Baptist PCPs / UM PCP, hospital asks hit the hospital rows', () => {
    assert.equal(HN.resolveRowName('does Humana have Baptist primary care doctors?'), 'Baptist PCPs');
    assert.equal(HN.resolveRowName('does HealthSun have UM PCPs?'), 'UM PCP');
    assert.equal(HN.resolveRowName('is Baptist Hospital in-network for Humana?'), 'Baptist Hospital');
    assert.equal(HN.resolveRowName('is University of Miami hospital in-network for Humana?'), 'University of Miami');
  });
});

describe('year 2026 does not use this tab', () => {
  it('returns null so 2026 HOSPITALS HTML stays in charge', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', medicareMax, 2026), null);
    assert.equal(HN.inNetwork('University of Miami', humana, 2026), null);
    assert.equal(HN.lookup({ year: 2026, rowName: 'UM PCP', plan: healthSun }).inNetwork, null);
  });
});

describe('grid wins; UM site only for extra carriers / agreeing plan IDs', () => {
  it('Aetna is No on the grid even though UM\'s page did not list Aetna', () => {
    const r = HN.lookup({ year: 2027, rowName: 'UM PCP', plan: aetnaHmo });
    assert.equal(r.inNetwork, false);
    assert.equal(r.source.kind, 'thei-grid');
  });

  it('Prominence UM PCP Yes is from UM\'s site (no grid column)', () => {
    const r = HN.lookup({
      year: 2027,
      rowName: 'UM PCP',
      plan: { carrier: 'Prominence', name: 'Prominence Plus (HMO)' },
    });
    assert.equal(r.inNetwork, true);
    assert.equal(r.source.kind, 'um-site');
    assert.match(r.note, /no Hospitals x Carrier column/i);
  });

  it('Freedom / Optimum are UM specialty + hospital only (no UM PCP), from UM\'s site', () => {
    const freedom = HN.lookup({
      year: 2027,
      rowName: 'UM PCP',
      plan: { carrier: 'Freedom', name: 'Freedom VIP Care' },
    });
    assert.equal(freedom.inNetwork, false);
    assert.equal(freedom.source.kind, 'um-site');
    const hosp = HN.lookup({
      year: 2027,
      rowName: 'University of Miami',
      plan: { carrier: 'Optimum', name: 'Optimum Platinum Plan' },
    });
    assert.equal(hosp.inNetwork, true);
    assert.equal(hosp.source.kind, 'um-site');
  });

  it('Gold Kidney has no column — blank, not No', () => {
    const p = { carrier: 'Gold Kidney', planId: 'H1526-002', name: 'Gold Kidney' };
    assert.equal(HN.hospitalColumnFor(p), '');
    assert.equal(HN.pcpIn('Baptist PCPs', p), null);
  });

  it('Humana UM specialty Yes is labeled as from UM\'s site (grid has no specialty row)', () => {
    const s = HN.umSpecialty(humana, 2027);
    assert.equal(s.inNetwork, true);
    assert.equal(s.source.kind, 'um-site');
    assert.match(s.note, /no UM Specialty row/i);
  });
});

describe('HTML 2027 hospital payload', () => {
  it('injects the compact Hospitals x Carrier rows including Baptist PCPs and UM PCP', () => {
    const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /id="hospitals-2027-data"/);
    assert.match(html, /Baptist PCPs/);
    assert.match(html, /UM PCP/);
    assert.match(html, /HOSPITALS_2027/);
    const m = html.match(/<script id="hospitals-2027-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(m, 'hospitals-2027-data block missing');
    const payload = JSON.parse(m[1]);
    assert.equal(payload.year, 2027);
    const names = payload.rows.map((r) => r.hospital);
    assert.ok(names.includes('Baptist PCPs'));
    assert.ok(names.includes('UM PCP'));
    const baptist = payload.rows.find((r) => r.hospital === 'Baptist PCPs');
    assert.deepEqual([...baptist.yes].sort(), ['FL BLUE', 'MedicareMax']);
    const um = payload.rows.find((r) => r.hospital === 'UM PCP');
    assert.deepEqual([...um.yes].sort(), ['HealthSun', 'Simply']);
  });
});
