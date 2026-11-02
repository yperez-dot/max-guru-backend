/**
 * 2027 hospital × carrier Yes/No from the THEI Plan Comparison Grid tab
 * "Hospitals x Carrier" (data/hospitals-x-carrier-2027.json).
 *
 * PCP questions use the Baptist PCPs and UM PCP rows.
 * Hospital questions use Baptist Hospital / University of Miami and the other hospital rows.
 * The grid wins over UHealth's public Insurance Plans Accepted page. That page is stored only
 * as umSiteSupplement: extra carriers with no grid column (Prominence, Freedom, Optimum) plus
 * plan-level IDs that agree with the grid. 2026 stays on the HTML HOSPITALS list — this module
 * returns null for year 2026 so it does not overlay 2026 answers.
 */
'use strict';

const DATA = require('../data/hospitals-x-carrier-2027.json');

const BAPTIST_PCP = 'Baptist PCPs';
const UM_PCP = 'UM PCP';
const BAPTIST_HOSPITAL = 'Baptist Hospital';
const UM_HOSPITAL = 'University of Miami';

const CONTRACT_COLUMN = {
  H1036: 'Humana',
  H7617: 'Humana PPO',
  H5420: 'MedicareMax',
  H1045: 'Preferred Care Partner',
  H1889: 'UHC Dual Complete',
  H1019: 'CarePlus',
  H1290: 'Devoted HMO',
  H4140: 'Doctors',
  H5431: 'HealthSun',
  H5471: 'Simply',
  H0982: 'Solis',
  H1032: 'WellCare',
  H1035: 'FL BLUE',
  H5434: 'FL BLUE',
  H1609: 'Aetna',
  H5521: 'Aetna PPO',
};

function contractOf(planId) {
  return (String(planId || '').toUpperCase().match(/^([HR]\d{4})/) || [])[1] || '';
}

function blobOf(plan) {
  if (!plan) return '';
  return [
    plan.carrier, plan.name, plan.planName, plan.type,
    plan.planId, plan.id, plan.label,
  ].filter(Boolean).join(' ');
}

/**
 * Map a THEI plan (id / carrier / type / name) onto a Hospitals x Carrier column.
 * Empty string = no column (do not invent Yes or No). Gold Kidney has none.
 */
function hospitalColumnFor(plan) {
  const id = String((plan && (plan.planId || plan.id)) || '').toUpperCase();
  const contract = contractOf(id);
  const carrier = String((plan && plan.carrier) || '');
  const name = String((plan && (plan.name || plan.planName || plan.label)) || '');
  const type = String((plan && plan.type) || '');
  const blob = `${carrier} ${name} ${type} ${id}`;

  if (contract === 'R0759') {
    if (/dual complete/i.test(name) || /dual complete/i.test(blob)) return 'UHC Dual Complete';
    return 'AARP/UHC Choice PPO';
  }
  if (CONTRACT_COLUMN[contract]) {
    if (contract === 'H1609' && (/\bppo\b/i.test(type) || /\bppo\b/i.test(name))) return 'Aetna PPO';
    return CONTRACT_COLUMN[contract];
  }

  if (/healthsun/i.test(blob)) return 'HealthSun';
  if (/\bsimply\b/i.test(blob)) return 'Simply';
  if (/florida blue|fl blue|\bbcbs\b/i.test(blob)) return 'FL BLUE';
  if (/medicaremax|preferred care network|\bpcn\b/i.test(blob)) return 'MedicareMax';
  if (/preferred care partner/i.test(blob)) return 'Preferred Care Partner';
  if (/dual complete/i.test(blob)) return 'UHC Dual Complete';
  if (/aarp|choice ppo/i.test(blob)) return 'AARP/UHC Choice PPO';
  if (/careplus|care plus/i.test(blob)) return 'CarePlus';
  if (/devoted/i.test(blob)) return 'Devoted HMO';
  if (/doctors/i.test(blob)) return 'Doctors';
  if (/solis/i.test(blob)) return 'Solis';
  if (/wellcare/i.test(blob)) return 'WellCare';
  if (/humana/i.test(blob)) {
    if (/\bppo\b/i.test(type) || /\bppo\b/i.test(name) || contract === 'H7617') return 'Humana PPO';
    return 'Humana';
  }
  if (/aetna/i.test(blob)) {
    if (/\bppo\b/i.test(type) || /\bppo\b/i.test(name)) return 'Aetna PPO';
    return 'Aetna';
  }
  return '';
}

function rowByName(name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return (DATA.rows || []).find((r) => String(r.hospital).toLowerCase() === want) || null;
}

function cellValue(rowName, plan) {
  const row = rowByName(rowName);
  if (!row) return '';
  const col = hospitalColumnFor(plan);
  if (!col) return '';
  return String((row.byCarrier || {})[col] || '').trim();
}

function isYes(v) {
  return /^yes\b/i.test(String(v || '').trim());
}
function isNo(v) {
  return /^no\b/i.test(String(v || '').trim());
}

function yearOf(year) {
  return Number(year) === 2026 ? 2026 : 2027;
}

function umSiteSource() {
  const src = (DATA.umSiteSupplement && DATA.umSiteSupplement.source) || {};
  return {
    kind: 'um-site',
    url: src.url || '',
    fetched: src.fetched || '',
    tab: src.tab || '',
    label: "UHealth's Insurance Plans Accepted page (not the THEI grid)",
  };
}

function extraCarrierFor(plan) {
  const extras = (DATA.umSiteSupplement && DATA.umSiteSupplement.extraCarriers) || [];
  const blob = blobOf(plan);
  if (!blob) return null;
  return extras.find((e) => new RegExp(`\\b${String(e.carrier).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(blob)) || null;
}

function planLevelAgree(plan) {
  const list = (DATA.umSiteSupplement && DATA.umSiteSupplement.planLevelAgrees) || [];
  const id = String((plan && (plan.planId || plan.id)) || '').toUpperCase();
  if (!id) return null;
  return list.find((p) => (p.planIds || []).some((x) => String(x).toUpperCase() === id)) || null;
}

/**
 * Grid cell for a row × plan. Empty string = no column or a blank cell (do not invent).
 * year 2026 → '' (this file is 2027-only).
 */
function cell(rowName, plan, year) {
  if (yearOf(year) === 2026) return '';
  return cellValue(rowName, plan);
}

/**
 * true = Yes, false = No, null = blank / no column / 2026.
 * Does not consult the UM site — use lookup() when extra carriers matter.
 */
function pcpIn(rowName, plan, year) {
  if (yearOf(year) === 2026) return null;
  const v = cellValue(rowName, plan);
  if (isYes(v)) return true;
  if (isNo(v)) return false;
  return null;
}

function inNetwork(rowName, plan, year) {
  return pcpIn(rowName, plan, year);
}

function fromUmSite(rowName, plan) {
  const extra = extraCarrierFor(plan);
  if (!extra) return null;
  const row = String(rowName || '').toLowerCase();
  let hit = null;
  if (row === UM_PCP.toLowerCase() || row.includes('pcp')) hit = extra.pcp;
  else if (row.includes('specialty')) hit = extra.specialty;
  else hit = extra.hospital;
  if (hit == null) return null;
  return {
    inNetwork: Boolean(hit),
    value: hit ? 'Yes' : 'No',
    source: umSiteSource(),
    extraCarrier: extra.carrier,
    note: `${extra.carrier} has no Hospitals x Carrier column. This Yes/No is from UHealth's site (${(DATA.umSiteSupplement.source || {}).fetched || ''}).`,
  };
}

/**
 * Full 2027 lookup: grid first, then UM-site extra carriers when the grid has no column.
 */
function lookup({ year, rowName, plan } = {}) {
  const y = yearOf(year);
  if (y === 2026) {
    return {
      year: 2026,
      rowName: rowName || '',
      inNetwork: null,
      value: '',
      column: '',
      source: { kind: '2026-html', label: '2026 HOSPITALS list in the Max UI — not this tab' },
    };
  }
  const col = hospitalColumnFor(plan);
  const v = col ? cellValue(rowName, plan) : '';
  const src = DATA.source || {};
  if (isYes(v) || isNo(v)) {
    const agree = planLevelAgree(plan);
    return {
      year: 2027,
      rowName,
      inNetwork: isYes(v),
      value: isYes(v) ? 'Yes' : 'No',
      column: col,
      source: {
        kind: 'thei-grid',
        tab: src.tab,
        workbook: src.workbook,
        pulled: src.pulled,
        label: 'THEI 2027 Plan Comparison Grid, Hospitals x Carrier tab',
      },
      umSiteAgrees: agree
        ? { listedAs: agree.listedAs, specialty: agree.specialty, fetched: (DATA.umSiteSupplement.source || {}).fetched }
        : null,
    };
  }
  const extra = fromUmSite(rowName, plan);
  if (extra) {
    return { year: 2027, rowName, column: '', ...extra };
  }
  return {
    year: 2027,
    rowName,
    inNetwork: null,
    value: v,
    column: col,
    source: { kind: 'thei-grid', tab: src.tab, label: 'THEI 2027 Plan Comparison Grid, Hospitals x Carrier tab' },
    note: col
      ? `The ${rowName} × ${col} cell is blank on the grid — do not invent Yes or No.`
      : 'This carrier has no Hospitals x Carrier column. Do not invent Yes or No unless it is in umSiteSupplement.',
  };
}

function umSpecialty(plan, year) {
  if (yearOf(year) === 2026) return null;
  const extra = extraCarrierFor(plan);
  if (extra) {
    return {
      inNetwork: Boolean(extra.specialty),
      source: umSiteSource(),
      note: 'The grid has no UM Specialty row. This is from UHealth\'s site.',
    };
  }
  const agree = planLevelAgree(plan);
  if (agree && typeof agree.specialty === 'boolean') {
    return {
      inNetwork: agree.specialty,
      source: umSiteSource(),
      listedAs: agree.listedAs,
      note: 'The grid has no UM Specialty row. This plan-level specialty mark is from UHealth\'s site and agrees with the grid UM PCP / hospital columns.',
    };
  }
  return null;
}

const PCP_ASK_RE = /\b(pcps?|primary\s+care|family\s+(?:medicine|practice|doctor)|internal\s+medicine)\b/i;
const HOSPITAL_ASK_RE = /\b(hospital|inpatient|facility|campus|umhc)\b/i;

function resolveRowName(askText) {
  const t = String(askText || '');
  const pcp = PCP_ASK_RE.test(t);
  const hosp = HOSPITAL_ASK_RE.test(t);
  const baptist = /\bbaptist\b/i.test(t);
  const um = /\b(?:uhealth|ummg|umhc|university of miami|\bum\b)\b/i.test(t);
  if (baptist && pcp && !hosp) return BAPTIST_PCP;
  if (um && pcp && !hosp) return UM_PCP;
  if (baptist && hosp && !pcp) return BAPTIST_HOSPITAL;
  if (um && hosp && !pcp) return UM_HOSPITAL;
  if (baptist && pcp) return BAPTIST_PCP;
  if (um && pcp) return UM_PCP;
  if (baptist) return BAPTIST_HOSPITAL;
  if (um) return UM_HOSPITAL;
  return '';
}

function promptRows() {
  return (DATA.rows || []).map((r) => ({
    hospital: r.hospital,
    kind: r.kind,
    yes: Object.entries(r.byCarrier || {}).filter(([, v]) => isYes(v)).map(([c]) => c),
    no: Object.entries(r.byCarrier || {}).filter(([, v]) => isNo(v)).map(([c]) => c),
  }));
}

function promptPayload() {
  const src = DATA.source || {};
  return {
    about: DATA.about,
    year: 2027,
    source: src,
    rows: promptRows(),
    umSiteSupplement: DATA.umSiteSupplement || null,
  };
}

function yesCarriers(rowName) {
  const row = rowByName(rowName);
  if (!row) return [];
  return Object.entries(row.byCarrier || {}).filter(([, v]) => isYes(v)).map(([c]) => c);
}

module.exports = {
  DATA,
  BAPTIST_PCP,
  UM_PCP,
  BAPTIST_HOSPITAL,
  UM_HOSPITAL,
  hospitalColumnFor,
  rowByName,
  cell,
  pcpIn,
  inNetwork,
  lookup,
  umSpecialty,
  extraCarrierFor,
  resolveRowName,
  promptRows,
  promptPayload,
  yesCarriers,
  yearOf,
};
