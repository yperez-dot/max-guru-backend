/**
 * MedicarePro CRM "Client Print" PDFs (and a paste of the same text).
 *
 * The print is a letterhead (agent contact + the client name with no "Name:" label), an intro,
 * then Plans / Providers / Prescription Drugs / Pharmacies, then duplicate "Rx Cards" cut-outs
 * and medicareproapp.com footers. None of the letterhead, intro, footers, page numbers or
 * cut-outs is the client's own ZIP, and the office ZIP must never be used as hers.
 */
const DE = require('./doctorEntries');
const DN = require('../artifacts/doctor-name.js');
const R = require('./comparisonRules');

const MONTHS = {
  january: '01', jan: '01', february: '02', feb: '02', march: '03', mar: '03',
  april: '04', apr: '04', may: '05', june: '06', jun: '06', july: '07', jul: '07',
  august: '08', aug: '08', september: '09', sep: '09', sept: '09', october: '10',
  oct: '10', november: '11', nov: '11', december: '12', dec: '12',
};

const SECTION_HEAD = {
  plans: /^\s*plans\s*$/i,
  providers: /^\s*providers\s*$/i,
  meds: /^\s*prescription\s+drugs?\s*$/i,
  pharmacy: /^\s*pharmac(?:y|ies)\s*$/i,
  rxCards: /^\s*rx\s+cards\s*$/i,
};

const PRACTICE_NAME_RE = /\b(?:eyes|vision|optical|optometry|associates?|clinics?|centers?|centres?|groups?|dental|dentistry|pharmacy|pharmacies|smiles?)\b/i;
const PCP_RE = /\b(?:pcp|primary(?:\s+care)?)\b/i;
const INTRO_RE = /below is a list of your (?:annual )?healthcare information/i;
const AGENT_NEAR_RE = /\b(?:co-?owner|health insurance|agent|the health experts)\b|@|\(\d{3}\)\s*\d{3}|^\s*\d+\s+\w+.+\b(?:ave|avenue|st|street|blvd|rd|road)\b/i;

function isMedicareProClientPrint(text) {
  const t = String(text || '');
  if (/\bplan\s+name\s*:/i.test(t) && /\bprescription\s+drugs\b/i.test(t) && /^\s*providers\s*$/im.test(t)) return true;
  if (/medicareproapp\.com/i.test(t) && /\bprescription\s+drugs\b/i.test(t) && /^\s*plans\s*$/im.test(t)) return true;
  if (/client\s*print/i.test(t) && /\brx\s+cards\b/i.test(t) && /^\s*providers\s*$/im.test(t)) return true;
  return false;
}

function isChromeLine(line) {
  const l = String(line || '');
  if (/medicareproapp\.com/i.test(l)) return true;
  if (/^\s*\d+\s*\/\s*\d+\s*$/.test(l)) return true;
  if (/client\s*print/i.test(l)) return true;
  if (/^\s*\d{1,2}\/\d{1,2}\/\d{2},?\s+\d{1,2}:\d{2}\s*[ap]m\s*$/i.test(l)) return true;
  if (/^\s*my\s+drug\s+list\s*$/i.test(l)) return true;
  if (/^\s*drug\s+name\b.*\bdosage\b/i.test(l)) return true;
  return false;
}

function formatPrintDate(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const named = s.match(/\b([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (named && MONTHS[named[1].toLowerCase()]) {
    return `${MONTHS[named[1].toLowerCase()]}.${named[2].padStart(2, '0')}.${named[3]}`;
  }
  const num = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  if (num) {
    const y = num[3].length === 2 ? `20${num[3]}` : num[3];
    return `${num[1].padStart(2, '0')}.${num[2].padStart(2, '0')}.${y}`;
  }
  return s;
}

function isPersonName(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return false;
  if (/@|\d{5}|\(\d{3}\)|https?:/i.test(t)) return false;
  if (/\b(?:agent|owner|insurance|health experts|below is|plan name|address|phone|devoted|humana|medicare|client print)\b/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 6) return false;
  return words.every((w) => /^(?:[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.-]*|de|del|de la|la|los|y|&)$/i.test(w));
}

function letterheadClientName(lines) {
  const head = [];
  for (const line of lines) {
    if (SECTION_HEAD.plans.test(line) || SECTION_HEAD.providers.test(line)) break;
    if (isChromeLine(line)) continue;
    head.push(line);
  }
  const people = [];
  head.forEach((line, i) => {
    const trimmed = line.trim();
    // Two-column letterhead glues the agent name to the intro with a wide gap.
    const lead = trimmed.split(/\s{2,}/)[0].trim();
    const nameSrc = isPersonName(lead) ? lead : (isPersonName(trimmed) ? trimmed : '');
    if (!nameSrc) return;
    people.push({ i, indent: (line.match(/^\s*/) || [''])[0].length, name: DN.displayPersonName(nameSrc) });
  });
  if (!people.length) return '';
  // Right-aligned unlabeled name is the client; the agent sits left with the office address.
  const maxIndent = Math.max(...people.map((p) => p.indent));
  if (maxIndent >= 24) {
    const right = people.filter((p) => p.indent >= maxIndent - 8);
    if (right.length) return right[0].name;
  }
  const introAt = head.findIndex((line) => INTRO_RE.test(line));
  const agent = people.find((p) => head.slice(p.i + 1, p.i + 6).some((x) => {
    const xi = (x.match(/^\s*/) || [''])[0].length;
    return AGENT_NEAR_RE.test(x) && Math.abs(xi - p.indent) <= 12;
  }));
  const rest = people.filter((p) => !agent || p.name.toLowerCase() !== agent.name.toLowerCase());
  if (introAt >= 0) {
    const before = rest.filter((p) => p.i < introAt);
    if (before.length) return before[before.length - 1].name;
  }
  return (rest[0] || people[0]).name;
}

function splitPrintSections(text) {
  const lines = String(text || '').replace(/\f/g, '\n').split('\n');
  const out = { head: [], plans: [], providers: [], meds: [], pharmacy: [] };
  let cur = 'head';
  for (const line of lines) {
    if (isChromeLine(line)) continue;
    if (SECTION_HEAD.rxCards.test(line)) break;
    if (SECTION_HEAD.plans.test(line)) { cur = 'plans'; continue; }
    if (SECTION_HEAD.providers.test(line)) { cur = 'providers'; continue; }
    if (SECTION_HEAD.meds.test(line)) { cur = 'meds'; continue; }
    if (SECTION_HEAD.pharmacy.test(line)) { cur = 'pharmacy'; continue; }
    out[cur].push(line);
  }
  return out;
}

function normPlan(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Map a CRM marketing name ("DEVOTED CORE 062 FL (HMO)") to a 2027 grid plan ID when the match is unique. */
function matchPlanName(raw, { county = '', year = 2027 } = {}) {
  const printed = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!printed) return { planId: '', name: '', confidence: 'none' };
  const hay = ` ${normPlan(printed)} `;
  const rows = R.gridPlansForCounty(county || '', year) || [];
  const hits = [];
  for (const g of rows) {
    const planName = normPlan(g.planName);
    const carrier = normPlan(g.carrier);
    if (!planName) continue;
    const bare = carrier && planName.startsWith(`${carrier} `) ? planName.slice(carrier.length + 1) : planName;
    // "Gold Plus" alone is too generic; "Humana Gold Plus" / "CORE 062" are distinctive.
    if (!/\d/.test(bare) && bare.split(' ').length < 3 && planName.split(' ').length < 3) continue;
    if (hay.includes(` ${planName} `) || (bare && hay.includes(` ${bare} `))) {
      const id = String(g.planId || g.id || '').toUpperCase();
      hits.push({
        id,
        key: id.slice(0, 9),
        name: g.planName,
        carrier: g.carrier,
        len: Math.max(planName.length, bare.length),
      });
    }
  }
  hits.sort((a, b) => b.len - a.len);
  if (!hits.length) return { planId: '', name: printed, confidence: 'none' };
  const bestLen = hits[0].len;
  const top = hits.filter((h) => h.len === bestLen);
  const ids = [...new Set(top.map((h) => h.id).filter(Boolean))];
  const keys = [...new Set(top.map((h) => h.key).filter(Boolean))];
  if (keys.length === 1) {
    return { planId: ids[0], name: top[0].name, carrier: top[0].carrier, marketingName: printed, confidence: 'high' };
  }
  return { planId: '', name: printed, confidence: 'ambiguous', candidates: ids };
}

function plansFrom(lines) {
  const carrierLine = lines.map((l) => l.trim()).find((l) => l && !/:\s*\S/.test(l) && !isChromeLine(l)) || '';
  let planName = '';
  let effective = '';
  let status = '';
  let planType = '';
  for (const raw of lines) {
    const l = raw.trim();
    const m = l.match(/^(plan\s+name|effective\s+date|status|plan\s+type)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/\s+/g, ' ');
    const val = m[2].trim();
    if (key === 'plan name') planName = val;
    else if (key === 'effective date') effective = val;
    else if (key === 'status') status = val;
    else if (key === 'plan type') planType = val;
  }
  const matched = matchPlanName(planName || carrierLine);
  return {
    carrier: carrierLine,
    marketingName: planName,
    effectiveDate: formatPrintDate(effective),
    status,
    planType,
    ...matched,
    name: matched.name || planName,
  };
}

function isPracticeName(name) {
  const t = String(name || '').trim();
  if (!t || /^(?:dr|dra|doctor|doctora)\b/i.test(t)) return false;
  if (DE.looksPractice(t)) return true;
  return PRACTICE_NAME_RE.test(t);
}

function providersFromPrint(lines) {
  const providers = [];
  for (const raw of lines) {
    if (!raw.trim() || isChromeLine(raw)) continue;
    const m = raw.trim().match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) continue;
    const name = DN.displayPersonName(m[1].trim());
    const specialty = m[2].trim();
    if (!name) continue;
    const practiceOnly = isPracticeName(name);
    providers.push({
      specialty,
      people: [{
        name,
        credential: '',
        titled: false,
        role: practiceOnly ? 'practice' : 'doctor',
        ...(practiceOnly ? { note: 'a practice — no doctor named' } : {}),
      }],
      practice: practiceOnly ? name : '',
      address: '',
      phone: '',
      notes: [],
    });
  }
  return providers;
}

function medLinesFrom(lines) {
  const out = [];
  for (const raw of lines) {
    const l = raw.replace(/^\s+/, '').trim();
    if (!l || isChromeLine(raw) || /^\.+$/.test(l)) continue;
    if (SECTION_HEAD.pharmacy.test(l) || SECTION_HEAD.rxCards.test(l)) break;
    out.push(l.replace(/\s+/g, ' '));
  }
  return out;
}

function pharmaciesFromPrint(lines) {
  const out = [];
  let cur = null;
  for (const raw of lines) {
    if (isChromeLine(raw) || SECTION_HEAD.rxCards.test(raw)) break;
    const l = String(raw || '').trim();
    if (!l) continue;
    const addr = l.match(/^address\s*:\s*(.*)$/i);
    const phone = l.match(/^(?:phone|tel|ph)\s*:\s*(.*)$/i);
    if (addr) {
      if (!cur) { cur = { name: '', address: '', phone: '' }; out.push(cur); }
      cur.address = addr[1].trim();
      continue;
    }
    if (phone) {
      if (!cur) { cur = { name: '', address: '', phone: '' }; out.push(cur); }
      cur.phone = phone[1].trim();
      continue;
    }
    cur = { name: l, address: '', phone: '' };
    out.push(cur);
  }
  return out.filter((p) => p.name);
}

function zipHintsFrom(pharmacies) {
  const hints = [];
  for (const p of pharmacies || []) {
    const z = String(p.address || '').match(/(?:(?:FL|Fla|Florida)\.?\s*)(\d{5})(?:-\d{4})?\s*$/i)
      || String(p.address || '').match(/,\s*(\d{5})(?:-\d{4})?\s*$/);
    if (z && z[1] !== '33172' && !hints.includes(z[1])) hints.push(z[1]);
  }
  return hints;
}

function parseMedicareProPrint(text) {
  const sec = splitPrintSections(text);
  const clientName = letterheadClientName(String(text || '').replace(/\f/g, '\n').split('\n'));
  const currentPlan = plansFrom(sec.plans);
  const providers = providersFromPrint(sec.providers);
  const meds = medLinesFrom(sec.meds);
  const pharmacies = pharmaciesFromPrint(sec.pharmacy);
  const zipHints = zipHintsFrom(pharmacies);
  const questions = [];
  const notes = [];

  if (currentPlan.marketingName || currentPlan.name) {
    if (currentPlan.confidence === 'high' && currentPlan.planId) {
      notes.push(`Current plan: ${currentPlan.name} (${currentPlan.planId}).`);
    } else {
      const shown = currentPlan.marketingName || currentPlan.name;
      questions.push({
        kind: 'plan',
        text: `Current plan is listed as "${shown}" — I could not match it to a grid ID. Confirm the plan ID.`,
      });
    }
  }
  if (currentPlan.effectiveDate) {
    notes.push(`Current plan effective ${currentPlan.effectiveDate} (workup stays 2027 for AEP).`);
  }

  const pcps = providers.filter((p) => PCP_RE.test(p.specialty) && p.people.some((who) => who.role !== 'practice'));
  if (pcps.length >= 2) {
    const names = pcps.map((p) => p.people[0].name);
    questions.push({
      kind: 'pcp',
      text: `Two PCPs are listed (${names.join(' and ')}) — which one is the client keeping?`,
    });
  }

  for (const p of providers) {
    for (const who of p.people) {
      if (who.note) questions.push({ kind: 'doctor', doctor: who.name, text: `${who.name}${p.specialty ? ` (${p.specialty})` : ''}: ${who.note}.` });
    }
  }

  if (zipHints.length) notes.push(`Pharmacy ZIP hints (confirm the client's ZIP, never auto-filled): ${zipHints.join(', ')}.`);
  notes.push("The PDF doesn't list the client's own ZIP — enter her ZIP.");

  const doctors = providers.flatMap((p) => p.people.map((who) => ({
    name: who.name,
    role: who.role,
    specialty: p.specialty,
    practice: p.practice,
    address: p.address,
    phone: p.phone,
    ...(who.note ? { note: who.note } : {}),
  })));

  return {
    clientName,
    zip: '',
    currentPlan,
    providers,
    doctors,
    meds,
    skippedOtc: [],
    pharmacies,
    pharmacy: pharmacies[0] || null,
    zipHints,
    questions,
    notes,
  };
}

function addressWithoutZip(addr) {
  return String(addr || '')
    .replace(/,?\s*(?:(?:FL|Fla|Florida)\.?\s*)\d{5}(?:-\d{4})?\b/gi, '')
    .replace(/,?\s*\d{5}(?:-\d{4})?\s*$/g, '')
    .replace(/[,\s]+$/, '')
    .trim();
}

module.exports = {
  isMedicareProClientPrint,
  parseMedicareProPrint,
  matchPlanName,
  formatPrintDate,
  isChromeLine,
  addressWithoutZip,
};
