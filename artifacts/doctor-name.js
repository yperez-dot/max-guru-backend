/**
 * One doctor-name normalizer for Max: NPPES search, every carrier directory match, the comparison grid and the
 * Excel/PDF export all read names through here (overhaul, 2026-10-17). Works in Node and in the browser
 * (window.MaxDoctorName, loaded before comparison-export.js).
 *
 *   cleanDoctorQuery   "Dr. HOWARD BUSH M.D., FACC - Baptist" → "Howard Bush" (what NPPES is searched with)
 *   parseName          → { firstName, middleName, lastName }
 *   surnameVariants    "Dearriba" → De Arriba / De-Arriba; "de Arriba" → DeArriba / De-Arriba (particle surnames)
 *   formatDoctorExportName  "Dr. David A Rodriguez M D" → "Dr. David A Rodriguez"; practices lose the "Dr."
 *   looksLikeOrganization (strict, decides org-first NPPES search) / isOrganizationName (display, broader)
 *   plainWords / sameDoctorName / sameNameIgnoringSpacing — matching
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.MaxDoctorName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── tokens ───────────────────────────────────────────────────────────────
  // Search: every trailing credential / suffix goes (NPPES matches the bare name).
  const CRED_TOKEN_RE = /^(MD|DO|NP|PA|PAC|RN|APRN|DDS|DMD|DPM|OD|DC|PHARMD|PHD|ARNP|FNP|DNP|FACC|FACP|FACS|FAAFP|MPH|MBA|MS|JR|SR|II|III)$/i;
  const CREDENTIAL_RE = /^(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD|ARNP|FNP|DNP)$/i;
  // Display: degrees go, a name suffix (Jr / Sr) stays.
  const DEGREE_TOKEN_RE = /^(?:MD|DO|DDS|DMD|DPM|OD|DC|NP|PA|PAC|APRN|ARNP|FNP|DNP|RN|PHD|PHARMD|FACC|FACP|FACS|JR\.?|SR\.?)$/i;
  const SPECIALTY_HINT_RE = /^(gynecologist|gynecology|gynecologic|obgyn|internist|internal|family|medicine|physician|allergist|hematologist|surgeon|pcp|primary|care|cardio|cardiology|cardiologist|ortho|orthopedic|orthopedics|orthopedist|gyn|obgyn|ob|derm|dermatology|dermatologist|eye|ophthalmologist|ophthalmology|optometrist|neuro|neurologist|gi|gastro|gastroenterologist|uro|urologist|endo|endocrinologist|onc|oncologist|pulm|pulmonologist|nephro|nephrologist|podiatrist|rheum|rheumatologist|ent|psych|psychiatrist|specialist|doctor|dr)$/i;
  // Strict org test (NPPES org-first search): a clinic word or "&".
  const ORG_HINT_RE = /\b(clinic|clinics|group|groups|specialists?|rehab|rehabilitation|therap(?:y|ies)|physical|neurology|neuro|associates?|centers?|centres?|institute|hospital|hospitals|medical|health|physicians?|practice|practices|llc|inc|pllc|dba|corp|corporation|services)\b|&/i;
  // Display org test adds practice words ("Miami Healthy Smiles", "Vision Unlimited").
  const ORG_DISPLAY_CLINIC_RE = /\b(neurology|rehab(?:ilitation)?|clinic|center|centre|institute|associates|group|hospital|medical|health|imaging|laboratory|therapy|specialists)\b/i;
  const ORG_NAME_RE = /\b(?:dental|dentistry|smiles?|orthodontics?|family\s+practice|practice|pharmacy|wellness|services|partners|physicians|surgery|surgical|urgent|labs?|vision|eye\s+care|care|llc|inc|pllc|corp|ltd|p\.a\.)(?=\s|$|,)|&/i;
  // Words that are a role / specialty, never part of the person's name (matching only).
  const ROLE_WORDS_RE = /\b(dr|md|m\.d|do|d\.o|pcp|primary|cardio\w*|neuro\w*|gyn\w*|obgyn|ortho\w*|derm\w*|uro\w*|gastro\w*|onc\w*|endo\w*|rheum\w*|pulm\w*|nephro\w*|podiat\w*|ophth\w*|optom\w*|ent|psych\w*|specialist|doctor)\b\.?/gi;
  const TITLE_RE = /^(?:(?:dra?s?|mr|mrs|ms)\.\s*|(?:dra?s?|doctor|doctora|mr|mrs|ms)\s+)/i;

  // Surname particles (Spanish, Portuguese, Italian, Dutch, French, Irish/Scottish).
  const SURNAME_PARTICLES = new Set(['de', 'del', 'della', 'dela', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'den', 'le', 'st', 'san', 'santa', 'mac', 'y']);
  // Particles that get typed glued to the surname ("Dearriba" for "De Arriba"), longest first.
  const JOINED_PARTICLES = ['de la', 'de los', 'de las', 'del', 'de', 'da', 'das', 'do', 'dos', 'di', 'du', 'van der', 'van', 'von', 'le', 'la'];

  // ─── casing / stripping ──────────────────────────────────────────────────
  function titleCase(t) {
    const s = String(t || '').trim();
    return s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : s;
  }
  /** ALL-CAPS NPPES names → "De Arriba", "O'Neil", "Santa-Cruz"; mixed case is left as typed. */
  function nameCase(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (s !== s.toUpperCase() || !/[A-Z]{2}/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  function stripTitle(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().replace(TITLE_RE, '');
  }
  /** Trailing degrees on a person's name: "M D", "MD", "M.D.", "DO", ", MD, PhD" … (Jr / Sr stay). */
  function stripDegreeSuffix(body) {
    const parts = String(body || '').replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    let changed = true;
    while (changed && parts.length > 2) {
      changed = false;
      const last = parts[parts.length - 1].replace(/[.\-/]/g, '');
      const two = parts.length > 3 ? (parts[parts.length - 2] + parts[parts.length - 1]).replace(/[.\-/]/g, '') : '';
      if (/^(?:JR|SR)$/i.test(last)) break;
      if (two && /^[A-Za-z]$/.test(parts[parts.length - 1].replace(/\./g, '')) && /^[A-Za-z]$/.test(parts[parts.length - 2].replace(/\./g, '')) && DEGREE_TOKEN_RE.test(two)) { parts.splice(-2, 2); changed = true; continue; }
      if (DEGREE_TOKEN_RE.test(last)) { parts.pop(); changed = true; }
    }
    return parts.join(' ');
  }
  /** Grid display: title-cased, credentials dropped. */
  function cleanName(n) {
    return titleCase(String(n || ''))
      .replace(/,?\s*\b(m\.?\s?d|d\.?\s?o|md|do|pa-?c|aprn|arnp|np|dpm|od|phd|facc|facp|facs)\b\.?/gi, '')
      .replace(/[\s,]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── organizations ───────────────────────────────────────────────────────
  function looksLikeOrganization(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (/^\d{10}$/.test(s)) return false;
    if (/\b(MD|DO|NP|ARNP|APRN)\b/i.test(s) && !ORG_HINT_RE.test(s)) return false;
    if (/^[A-Za-z][A-Za-z'.-]+,\s+[A-Za-z]/.test(s) && !ORG_HINT_RE.test(s)) return false;
    // Only a clinic word (or &) makes it a clinic. Four plain words is a person with two surnames.
    return ORG_HINT_RE.test(s);
  }
  /** Display test: a practice / organization, never "Dr. Miami Healthy Smiles". "Dr. …" typed by her is a person. */
  function looksLikeOrganizationDisplay(name) {
    const n = String(name || '').trim();
    if (!n || /^(dr|doctor)\b\.?\s/i.test(n)) return false;
    return ORG_DISPLAY_CLINIC_RE.test(n);
  }
  function isOrganizationName(name, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.organization === true || /^(?:NPI-?2|organization|org)$/i.test(String(o.entityType || ''))) return true;
    const body = String(name || '').replace(/^(?:dr|doctor)\.?\s+/i, '').trim();
    if (!body) return false;
    return looksLikeOrganizationDisplay(body) || ORG_NAME_RE.test(body);
  }

  // ─── search form ─────────────────────────────────────────────────────────
  function cleanDoctorQuery(name) {
    let s = String(name || '').replace(/\s+/g, ' ').trim();
    if (!s || /^\d{10}$/.test(s)) return s;
    // "Dr.Armando Rivero" — a dotted title may be glued to the name (Victor Rocha, 2026-10-08).
    s = s.replace(/^(?:(?:dra?s?|mr|mrs|ms)\.\s*|(?:dra?s?|doctor|mr|mrs|ms)\s+)/i, '');
    s = s.replace(/\(([^)]*)\)/g, ' ').replace(/\s+/g, ' ').trim();
    // "Natalie Regalado - Baptist Medical Group": the office after a dash is a hint (Jackie Alexander, 2026-10-13).
    const dashHead = s.split(/\s+[-–—]\s+/)[0].replace(/\*+$/, '').trim();
    if (dashHead !== s && dashHead.split(/\s+/).length >= 2 && !ORG_HINT_RE.test(dashHead)) s = dashHead;
    const isOrg = ORG_HINT_RE.test(s);
    const parts = s.split(/[\s,]+/).filter(Boolean);
    while (parts.length > 1) {
      const bare = parts[parts.length - 1].replace(/[.\-/]/g, '');
      // "David A Rodriguez M D": a degree typed as two letters (NPPES was searched for last name "D").
      const pair = parts.length > 3 ? (parts[parts.length - 2] + parts[parts.length - 1]).replace(/[.\-/]/g, '') : '';
      if (pair && bare.length === 1 && parts[parts.length - 2].replace(/[.\-/]/g, '').length === 1 && CRED_TOKEN_RE.test(pair)) { parts.splice(-2, 2); continue; }
      if (CRED_TOKEN_RE.test(bare) || (!isOrg && SPECIALTY_HINT_RE.test(bare))) parts.pop();
      else break;
    }
    if (isOrg) {
      while (parts.length > 1 && /^(llc|inc|pllc|pa|corp|co)\.?$/i.test(parts[parts.length - 1])) parts.pop();
    }
    let out = parts.join(' ');
    if (out === out.toUpperCase() && /[A-Z]/.test(out)) out = out.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
    return out;
  }
  function parseName(fullName) {
    if (!fullName || typeof fullName !== 'string') return {};
    let cleaned = fullName.trim();
    cleaned = cleaned.replace(TITLE_RE, '');
    cleaned = cleaned.replace(/\s+at\s+.+$/i, '');
    cleaned = cleaned.replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD|ARNP)\.?$/i, '').trim();
    if (cleaned.includes(',')) {
      const commaIdx = cleaned.indexOf(',');
      const last = cleaned.slice(0, commaIdx).trim();
      const rest = cleaned.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
      return { firstName: rest[0] || '', middleName: rest.slice(1).join(' '), lastName: last };
    }
    const parts = cleaned.split(/\s+/).filter(Boolean);
    while (parts.length && CREDENTIAL_RE.test(parts[parts.length - 1])) parts.pop();
    if (!parts.length) return {};
    if (parts.length === 1) return { lastName: parts[0] };
    return { firstName: parts[0], middleName: parts.slice(1, -1).join(' '), lastName: parts[parts.length - 1] };
  }

  // ─── particle surnames ───────────────────────────────────────────────────
  /** "Dearriba" → ["De Arriba", "De-Arriba"]; "Delaguarda" → "De La Guarda", …; plain names → []. */
  function joinedParticleSplits(lastName) {
    const raw = String(lastName || '').trim();
    if (!raw || /[\s-]/.test(raw)) return [];
    const low = raw.toLowerCase();
    const out = [];
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    for (const p of JOINED_PARTICLES) {
      const glued = p.replace(/\s+/g, '');
      if (!low.startsWith(glued) || low.length - glued.length < 3) continue;
      const words = p.split(' ').map(cap);
      const rest = cap(raw.slice(glued.length));
      out.push([...words, rest].join(' '), [...words, rest].join('-'));
    }
    return [...new Set(out)].slice(0, 4);
  }
  /** "de Arriba" / "De-Arriba" → ["DeArriba", "De-Arriba" | "De Arriba"]: the other spellings of a particle surname. */
  function splitParticleJoins(lastName) {
    const parts = String(lastName || '').trim().split(/[\s-]+/).filter(Boolean);
    if (parts.length < 2 || !SURNAME_PARTICLES.has(parts[0].toLowerCase())) return [];
    return [...new Set([parts.join(''), parts.join('-'), parts.join(' ')])].filter((v) => v !== String(lastName).trim());
  }
  /** Every spelling to try for a surname, the typed one first. */
  function surnameVariants(lastName) {
    const raw = String(lastName || '').trim();
    if (!raw) return [];
    return [...new Set([raw, ...joinedParticleSplits(raw), ...splitParticleJoins(raw)])];
  }
  /** Letters-only key: "De Arriba" = "Dearriba" = "DE-ARRIBA" → "dearriba". */
  function surnameKey(lastName) {
    return String(lastName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  }
  /** "Stephanie Sasha De La Guarda, DO" → "De La Guarda"; no particle → "". */
  function compoundLastName(name) {
    if (!name || typeof name !== 'string') return '';
    const cleaned = name.replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|MA|MS|MSN|MED|PharmD|PhD)\.?$/i, '').trim();
    const noComma = cleaned.includes(',') ? cleaned.slice(0, cleaned.indexOf(',')).trim() : cleaned;
    const parts = noComma.split(/\s+/).filter(Boolean);
    const head = cleaned.includes(',') ? 0 : 1;
    const at = parts.findIndex((w, i) => i >= head && i < parts.length - 1 && /^(?:de|del|da|das|do|dos|di|du|la|las|los|le|van|von|der|den|st\.?|san|santa|mc|mac|bin|ben|al|el|y)$/i.test(w));
    return at >= 0 ? parts.slice(at).join(' ') : '';
  }

  // ─── matching ────────────────────────────────────────────────────────────
  function plainWords(t) {
    return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(ROLE_WORDS_RE, ' ').split(/[^a-z']+/).filter((w) => w.length > 1);
  }
  function sameDoctorName(a, b) {
    const x = plainWords(a).join(' ');
    const y = plainWords(b).join(' ');
    return Boolean(x) && (x === y || x.includes(y) || y.includes(x));
  }
  /** Same letters once spaces / hyphens / "Dr." / " - practice" are ignored: "Edgardo de Arriba" ≈ "Edgardo Dearriba". */
  function sameNameIgnoringSpacing(a, b) {
    const key = (x) => plainWords(String(x || '').split(/\s+[-–—]\s+/)[0]).join('');
    const ka = key(a);
    return ka.length >= 6 && ka === key(b);
  }

  // ─── export display ──────────────────────────────────────────────────────
  /** "Dr. David A Rodriguez M D" → "Dr. David A Rodriguez"; "Dr. Miami Healthy Smiles" → "Miami Healthy Smiles". */
  function formatDoctorExportName(name, opts) {
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    const hasDr = /^(?:dr|doctor)\.?\s+/i.test(n);
    let body = n.replace(/^(?:dr|doctor)\.?\s+/i, '').trim();
    if (!body) return n;
    if (isOrganizationName(body, opts)) {
      if (body === body.toUpperCase() && /[A-Z]{2}/.test(body)) body = body.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
      return body;
    }
    if (!hasDr) return n;
    return 'Dr. ' + nameCase(stripDegreeSuffix(body));
  }

  return {
    CRED_TOKEN_RE, CREDENTIAL_RE, DEGREE_TOKEN_RE, SPECIALTY_HINT_RE, ORG_HINT_RE, ORG_NAME_RE, ROLE_WORDS_RE, SURNAME_PARTICLES,
    titleCase, nameCase, stripTitle, stripDegreeSuffix, cleanName,
    looksLikeOrganization, looksLikeOrganizationDisplay, isOrganizationName,
    cleanDoctorQuery, parseName,
    joinedParticleSplits, splitParticleJoins, surnameVariants, surnameKey, compoundLastName,
    plainWords, sameDoctorName, sameNameIgnoringSpacing,
    formatDoctorExportName,
  };
});
