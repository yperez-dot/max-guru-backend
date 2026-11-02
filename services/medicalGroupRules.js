/**
 * Medical-group carrier rules (max-knowledge/medical-group-carrier-rules.md).
 *
 * Baptist Health Medical Group PRIMARY CARE:
 *   2026 — Aetna (not Aetna Medicare HMO), HealthSpring, Florida Blue, Preferred Care Network
 *          (UHC MedicareMax, H5420). Not Humana, not Doctors HealthCare Plans
 *          (Yahoska, 2026-10-17: Nathalie Regalado NPI 1467795633 showed In on Humana).
 *   2027 — THEI Hospitals x Carrier tab, "Baptist PCPs" row: Florida Blue and MedicareMax only.
 *          Aetna PPO is Out. (Yahoska, 11.02.2026.)
 *
 * University of Miami PRIMARY CARE (2027 only):
 *   THEI Hospitals x Carrier tab, "UM PCP" row: HealthSun and Simply only.
 *   Humana is Yes at the UM *hospital* and No for UM PCP — do not confuse the two.
 *
 * The rule wins over a carrier directory "In".
 */
'use strict';

const HN = require('./hospitalNetworks');

const PRIMARY_CARE_RE = /\b(family\s+(?:medicine|practice)|internal\s+medicine|general\s+practice|geriatric|primary\s+care)\b/i;
const PCP_WORD_RE = /\b(pcp|primary(?:\s+care)?|family\s+doctor)\b/i;
const BHMG_RE = /\bbaptist\s+(?:health\s+)?medical\s+group\b|\bbhmg\b/i;
const UM_GROUP_RE = /\buhealth\b|\bummg\b|\bumhc\b|university of miami(?:\s+health|\s+medical)?|\bum\s+(?:pcp|primary)/i;

function yearOf(year) {
  return Number(year) === 2026 ? 2026 : 2027;
}

const GROUP_RULES = [
  {
    key: 'bhmg-pcp',
    label: 'Baptist Health Medical Group primary care',
    short: 'BHMG primary care',
    knownNpis: ['1467795633'], // Nathalie Regalado, Internal Medicine (Yahoska, 2026-10-17)
    accepts: 'Aetna (not Aetna Medicare HMO), HealthSpring, Florida Blue, Preferred Care Network (UHC MedicareMax)',
    accepts2027: 'Florida Blue and Preferred Care Network (UHC MedicareMax) — 2027 THEI Hospitals x Carrier, Baptist PCPs row',
    groupRe: BHMG_RE,
    acceptsForYear(year) {
      return yearOf(year) === 2026 ? this.accepts : this.accepts2027;
    },
    /** Does this plan column's carrier take the group's PCPs? */
    acceptsPlan(col, year) {
      if (yearOf(year) !== 2026) {
        const hit = HN.pcpIn(HN.BAPTIST_PCP, col, 2027);
        return hit === true;
      }
      const carrier = String((col && col.carrier) || '');
      const name = String((col && col.name) || '');
      const id = String((col && col.planId) || '').toUpperCase();
      const type = String((col && (col.type || (col.grid && col.grid.type))) || '');
      if (/florida blue|bcbs/i.test(carrier) || /florida blue|bcbs/i.test(name)) return true;
      if (/healthspring|cigna/i.test(carrier) || /healthspring|cigna/i.test(name)) return true;
      if (carrier === 'Aetna' || /aetna/i.test(name)) return !(/\bhmo\b/i.test(type) || /\bhmo\b/i.test(name));
      if (carrier === 'UnitedHealthcare' || /\buhc\b|unitedhealthcare|aarp/i.test(name)) {
        return id.startsWith('H5420') || /medicaremax|preferred care network/i.test(name);
      }
      return false;
    },
    /** Carrier-level label ("Humana", "Doctors HealthCare Plans") for a directory network entry. */
    acceptsCarrier(label, year) {
      const t = String(label || '');
      if (yearOf(year) !== 2026) {
        if (/florida blue|bcbs/i.test(t)) return true;
        if (/\buhc\b|unitedhealthcare|medicaremax/i.test(t)) return true; // plan level decides MedicareMax
        return false;
      }
      if (/florida blue|bcbs|healthspring|cigna/i.test(t)) return true;
      if (/aetna/i.test(t)) return true; // plan level decides HMO vs not
      if (/\buhc\b|unitedhealthcare|medicaremax/i.test(t)) return true; // plan level decides MedicareMax
      return false;
    },
  },
  {
    key: 'um-pcp',
    label: 'University of Miami primary care',
    short: 'UM PCP',
    knownNpis: [],
    accepts: 'HealthSun and Simply — 2027 THEI Hospitals x Carrier, UM PCP row',
    groupRe: UM_GROUP_RE,
    year: 2027, // 2026 UM doctors stay on the 2026 HOSPITALS list / directories
    acceptsForYear(year) {
      return yearOf(year) === 2026 ? '' : this.accepts;
    },
    acceptsPlan(col, year) {
      if (yearOf(year) === 2026) return true; // do not overlay 2026
      return HN.pcpIn(HN.UM_PCP, col, 2027) === true;
    },
    acceptsCarrier(label, year) {
      if (yearOf(year) === 2026) return true;
      const t = String(label || '');
      return /healthsun/i.test(t) || /\bsimply\b/i.test(t);
    },
  },
];

function plainWords(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(dr|dra|md|do|pcp)\b\.?/g, ' ').split(/[^a-z']+/).filter((w) => w.length > 1);
}

/** Text segments of the ask that mention this doctor (first + last name words). */
function segmentsFor(doctor, askText) {
  const names = [doctor && doctor.requestedName, doctor && doctor.doctorName].filter(Boolean);
  const segs = String(askText || '').replace(/\b(dr|dra)\./gi, '$1 ').split(/[\n;]|\.\s/);
  return segs.filter((seg) => {
    const sw = plainWords(seg);
    return names.some((nm) => {
      const w = plainWords(String(nm).split(/\s+[-\u2013\u2014]\s+/)[0]).filter((x) => x.length > 1);
      return w.length >= 2 && sw.includes(w[w.length - 1]) && (sw.includes(w[0]) || w[0].length <= 2);
    });
  });
}

/**
 * The group rule that applies to this doctor, or null. Primary care = NPI taxonomy, or the agent said PCP.
 */
function groupRuleFor(doctor, askText, year) {
  if (!doctor) return null;
  const y = yearOf(year);
  const npi = String(doctor.npi || '').replace(/\D/g, '');
  for (const rule of GROUP_RULES) {
    if (rule.year && rule.year !== y) continue;
    if (npi && rule.knownNpis.includes(npi)) return rule;
    const segs = segmentsFor(doctor, askText);
    const inGroup = rule.groupRe.test(String(doctor.requestedName || '')) || segs.some((s) => rule.groupRe.test(s));
    if (!inGroup) continue;
    const pc = PRIMARY_CARE_RE.test(String(doctor.specialty || '')) || segs.some((s) => PCP_WORD_RE.test(s)) || PCP_WORD_RE.test(String(doctor.requestedName || ''));
    if (pc) return rule;
  }
  return null;
}

/**
 * Before ranking: a group-rule doctor is not In on carriers the group does not take (carrier-level and plan-level).
 * Returns a new doctor object with groupRule set.
 */
function applyGroupRuleToDoctor(doctor, askText, planCarrierOf, year) {
  const y = yearOf(year);
  const rule = groupRuleFor(doctor, askText, y);
  if (!rule) return doctor;
  const carrierOfLabel = typeof planCarrierOf === 'function' ? planCarrierOf : () => '';
  const keepIn = [];
  const moveOut = [];
  for (const label of doctor.inNetworkPlans || []) {
    const col = { name: String(label), carrier: carrierOfLabel(label), planId: (String(label).match(/\b[HR]\d{4}-\d{3}/i) || [''])[0] };
    (rule.acceptsPlan(col, y) ? keepIn : moveOut).push(label);
  }
  return {
    ...doctor,
    groupRule: rule.key,
    inNetworkPlans: keepIn,
    outOfNetworkPlans: [...(doctor.outOfNetworkPlans || []), ...moveOut],
    networks: (doctor.networks || []).map((n) => (n && n.inNetwork && !rule.acceptsCarrier(n.carrier, y) ? { ...n, inNetwork: false, groupRule: rule.key } : n)),
    carriersIn: (doctor.carriersIn || []).filter((c) => rule.acceptsCarrier(c, y)),
  };
}

/**
 * After the columns are built: each group-rule doctor reads Out on every column whose carrier/plan the group does
 * not take, whatever the directory said. Returns the flag lines to show under the table.
 */
function applyGroupRulesToColumns(columns, doctors, whoOf, year) {
  const y = yearOf(year);
  const flags = [];
  for (const d of doctors || []) {
    const rule = d && d.groupRule ? GROUP_RULES.find((r) => r.key === d.groupRule) : null;
    if (!rule) continue;
    const who = whoOf(d);
    for (const c of columns || []) {
      if (rule.acceptsPlan(c, y)) continue;
      for (const k of ['in', 'inCarrier', 'unknown', 'notConfirmed']) {
        if (Array.isArray(c[k]) && c[k].includes(who)) c[k] = c[k].filter((x) => x !== who);
      }
      if (!Array.isArray(c.out)) c.out = [];
      if (!c.out.includes(who)) c.out.push(who);
    }
    const takes = rule.acceptsForYear ? rule.acceptsForYear(y) : rule.accepts;
    flags.push(`${who}: ${rule.label} takes only ${takes} — every other carrier shows ❌ Not in network, even if its directory lists the doctor.`);
  }
  return flags;
}

module.exports = { GROUP_RULES, groupRuleFor, applyGroupRuleToDoctor, applyGroupRulesToColumns };
