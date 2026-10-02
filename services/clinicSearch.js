/**
 * Clinic / group identity search for Max.
 *
 * CMS NPPES (NPI-2) first. Optional fetch of a *known clinic page* the agent
 * already has (or a tiny confirmed map). Never scrape Google/Bing SERPs.
 *
 * A clinic "insurances accepted" page is marketing, not network status:
 *   - Logo present → "Found a {carrier} logo on their site — here's the link.
 *     I recommend you call and confirm." Never verified In-network.
 *   - Logo absent (MNRS / Humana, Yahoska 2026-10-02) → "{carrier} is not
 *     listed on their accepted-insurances page (link). I recommend you call
 *     the office to confirm." Absence is NOT definitive OON if Find Care
 *     later returns IN. Prefer: not listed on clinic site + NPI Find Care.
 */

const {
  lookupByOrganizationName,
  lookupByNumber,
  lookupByName,
  looksLikeOrganization,
  extractNpi,
  parseName,
  formatClinicRecord,
} = require('./npiRegistry');

const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_HOST_RE = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu)(\.|$)/i;

/** Confirmed identity pages only — not a network directory. */
const KNOWN_CLINIC_SITES = [
  {
    match: /mnrs|miami neurology/i,
    siteUrl: 'https://miamiphysicaltherapy.com/insurances/',
    aliases: ['MNRS', 'MNRS Physical Therapy'],
    note: 'Yahoska 2026-10-02. Identity + marketing logos only.',
  },
];

/**
 * Logos on MNRS (and similar) pages live in image filenames / data-nectar-img-src,
 * not alt text (alts are often just "client").
 */
const CARRIER_PATTERNS = [
  { name: 'Humana', re: /\bhumana\b/i },
  { name: 'Aetna', re: /\baetna\b/i },
  { name: 'ASHP', re: /\bashp\b/i },
  { name: 'AvMed', re: /\bavmed\b/i },
  { name: 'Cigna', re: /\bcigna\b/i },
  { name: 'Doctors Healthcare', re: /\bdoctors[\s_-]*health|\bdhp[-_]logo\b/i },
  { name: 'GEHA', re: /\bgeha\b/i },
  { name: 'Golden Rule', re: /\bgolden[\s_-]*rule|\bgoldern[\s_-]*rule\b/i },
  { name: 'Hartford', re: /\bhartford\b/i },
  { name: 'Harvard Pilgrim', re: /\bharvard[\s_-]*pilgrim|\bhphc[-_]logo\b/i },
  { name: 'Medicare', re: /\bmedicare[-_]logo\b|\bmedicare\b/i },
  { name: 'NALC', re: /\bnalc\b/i },
  { name: 'PHCS', re: /\bphcs\b/i },
  { name: 'TRICARE', re: /\btricare\b/i },
  { name: 'UnitedHealthcare', re: /\bunited[\s_-]*health|\buhc[-_]logo\b|\buhc\b/i },
  { name: 'UAIC', re: /\buaic\b/i },
  { name: 'UMR', re: /\bumr[-_]logo\b|\bumr\b/i },
  { name: 'VA', re: /\bva[-_]logo\b/i },
  { name: 'Gallagher Bassett', re: /\bgallagher[\s_-]*bassett\b/i },
  { name: 'CarePlus', re: /\bcareplus\b/i },
  { name: 'Devoted', re: /\bdevoted\b/i },
  { name: 'Florida Blue', re: /\bflorida[\s_-]*blue\b|\bflblue\b/i },
  { name: 'Wellcare', re: /\bwellcare\b/i },
  { name: 'Simply', re: /\bsimply[\s_-]*health/i },
  { name: 'HealthSun', re: /\bhealthsun\b/i },
];

function knownSiteFor(name) {
  const s = String(name || '');
  return KNOWN_CLINIC_SITES.find((row) => row.match.test(s)) || null;
}

function isBlockedSearchUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return true;
    return SEARCH_HOST_RE.test(u.hostname);
  } catch {
    return true;
  }
}

function collectImageHaystack(html) {
  const bits = [];
  const attrRe = /\b(?:src|data-src|data-nectar-img-src|data-lazy-src|srcset|alt|title|aria-label)\s*=\s*(["'])([\s\S]*?)\1/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    bits.push(m[2]);
  }
  return bits.join('\n');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPageTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim() || null;
}

function extractCarrierLogos(html) {
  const imageHay = collectImageHaystack(html);
  const text = stripHtml(html);
  const hay = `${imageHay}\n${text}`;
  const listed = [];
  for (const row of CARRIER_PATTERNS) {
    if (row.re.test(hay) && !listed.includes(row.name)) listed.push(row.name);
  }
  return listed;
}

function extractNpisFromText(text) {
  const hits = String(text || '').match(/\b[12]\d{9}\b/g) || [];
  return [...new Set(hits)];
}

function normalizeAskedCarrier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hit = CARRIER_PATTERNS.find((row) => row.re.test(s) || row.name.toLowerCase() === s.toLowerCase());
  if (hit) return hit.name;
  if (/uhc|united/i.test(s)) return 'UnitedHealthcare';
  return s;
}

function logoPhrase({ askedCarrier, listed, siteUrl, foundLogo }) {
  const link = siteUrl || 'their site';
  if (foundLogo) {
    return `Found a ${askedCarrier} logo on their site — here's the link. I recommend you call and confirm.`;
  }
  return `${askedCarrier} is not listed on their accepted-insurances page (${link}). I recommend you call the office to confirm.`;
}

function formatSiteNotes({ siteUrl, listed, askedCarrier, title, aliases }) {
  const lines = [];
  if (title) lines.push(`Page title: ${title}`);
  if (aliases?.length) lines.push(`Site aliases: ${aliases.join('; ')}`);
  lines.push(`Insurances-accepted page: ${siteUrl}`);
  lines.push(
    listed.length
      ? `Logos/mentions on that page (marketing only, NOT verified In-network): ${listed.join(', ')}`
      : 'No carrier logos parsed on that page.'
  );

  if (askedCarrier) {
    const foundLogo = listed.some((n) => n.toLowerCase() === askedCarrier.toLowerCase());
    lines.push(`Agent wording: "${logoPhrase({ askedCarrier, listed, siteUrl, foundLogo })}"`);
    if (!foundLogo) {
      lines.push(
        `Absence of ${askedCarrier} on the clinic page is NOT definitive out-of-network. If lookup_provider_network / Find Care later returns IN, report both: not listed on clinic site + NPI Find Care IN. Never treat this page as verified In or Out.`
      );
    } else {
      lines.push(
        `A ${askedCarrier} logo on this page is a lead only. Never treat it as verified In-network. True In/Out is NPI + carrier Find Care / FHIR / guest directory.`
      );
    }
  } else {
    lines.push(
      'If the agent asked about a named carrier whose logo IS on the page: "Found a {carrier} logo on their site — here\'s the link. I recommend you call and confirm."'
    );
    lines.push(
      'If the agent asked about a named carrier whose logo is NOT on the page (e.g. Humana on MNRS): "{carrier} is not listed on their accepted-insurances page (link). I recommend you call the office to confirm." Absence is not definitive OON if Find Care returns IN.'
    );
  }
  lines.push('Never invent In/Out from this marketing page. Next: lookup_provider_network with npi=.');
  return lines;
}

async function fetchClinicPage(url, fetchImpl = fetch) {
  if (isBlockedSearchUrl(url)) {
    return {
      ok: false,
      error: 'Search-engine URLs are blocked (no Google/Bing SERPs). Pass the clinic’s own page URL.',
      url,
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Max-Medicare-Guru/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    const html = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, url, html: html.slice(0, 2000) };
    }
    const listed = extractCarrierLogos(html);
    const title = extractPageTitle(html);
    const aliases = [];
    if (/\bMNRS\b/i.test(`${title}\n${html}`)) aliases.push('MNRS', 'MNRS Physical Therapy');
    const npis = extractNpisFromText(`${html}\n${stripHtml(html)}`);
    return {
      ok: true,
      url,
      title,
      listed,
      aliases: [...new Set(aliases)],
      npis,
      textPreview: stripHtml(html).slice(0, 1500),
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'timeout' : err.message;
    return { ok: false, error: label, url };
  } finally {
    clearTimeout(timer);
  }
}

function mergeRecords(records) {
  const byNpi = new Map();
  for (const rec of records) {
    const npi = rec.npi || rec.number;
    if (!npi) continue;
    const formatted = rec.officialName ? rec : formatClinicRecord(rec);
    if (!byNpi.has(npi)) byNpi.set(npi, formatted);
    else {
      const cur = byNpi.get(npi);
      cur.aliases = [...new Set([...(cur.aliases || []), ...(formatted.aliases || [])])];
    }
  }
  return [...byNpi.values()];
}

async function searchClinicOrProvider({
  name = '',
  state = 'FL',
  zip,
  city,
  siteUrl,
  askedCarrier,
  fetchImpl = fetch,
} = {}) {
  const query = String(name || '').trim();
  const carrier = normalizeAskedCarrier(askedCarrier);
  const pastedNpi = extractNpi(query);
  const records = [];

  if (pastedNpi) {
    records.push(...(await lookupByNumber(pastedNpi)));
  }

  if (query && !pastedNpi) {
    if (looksLikeOrganization(query) || query.split(/\s+/).length >= 2) {
      records.push(...(await lookupByOrganizationName({
        organizationName: query,
        state,
        zip,
        city,
        limit: 5,
      })));
    }
    if (!records.length) {
      const parsed = parseName(query);
      if (parsed.lastName) {
        records.push(...(await lookupByName({ ...parsed, state, zip, limit: 5 })));
      }
    }
  }

  const known = knownSiteFor(query);
  const resolvedUrl = siteUrl || known?.siteUrl || null;
  let site = null;
  if (resolvedUrl) {
    site = await fetchClinicPage(resolvedUrl, fetchImpl);
    if (site.ok && site.npis?.length) {
      for (const npi of site.npis.slice(0, 3)) {
        const extra = await lookupByNumber(npi);
        records.push(...extra);
      }
    }
  }

  const merged = mergeRecords(records);
  if (known?.aliases) {
    for (const rec of merged) {
      rec.aliases = [...new Set([...(rec.aliases || []), ...known.aliases])];
    }
  }
  if (site?.ok && site.aliases?.length) {
    for (const rec of merged) {
      rec.aliases = [...new Set([...(rec.aliases || []), ...site.aliases])];
    }
  }

  const lines = [];
  lines.push(`Clinic/provider identity search for "${query}"${carrier ? ` (asked carrier: ${carrier})` : ''}:`);
  lines.push('Source: CMS NPPES (NPI-2 org / NPI-1 as needed). Not a carrier directory.');
  if (!merged.length) {
    lines.push(`No NPPES match. Try the legal org name, a 10-digit NPI, or the clinic website URL (not a Google search).`);
  } else {
    for (const rec of merged.slice(0, 5)) {
      lines.push('');
      lines.push(`**${rec.officialName}**`);
      lines.push(`NPI: ${rec.npi} (${rec.enumerationType || 'NPI'})`);
      if (rec.aliases?.length) lines.push(`Aliases: ${rec.aliases.join('; ')}`);
      if (rec.specialty) lines.push(`Taxonomy: ${rec.specialty}`);
      for (const addr of rec.addresses || []) {
        lines.push(`Address: ${addr.line}${addr.phone ? `  tel ${addr.phone}` : ''}`);
      }
    }
  }

  if (site) {
    lines.push('');
    if (!site.ok) {
      lines.push(`Clinic page fetch failed (${site.url}): ${site.error}`);
    } else {
      lines.push(...formatSiteNotes({
        siteUrl: site.url,
        listed: site.listed,
        askedCarrier: carrier,
        title: site.title,
        aliases: site.aliases,
      }));
    }
  } else {
    lines.push('');
    lines.push('No clinic website fetched. If the agent has the insurances page URL, call this tool again with siteUrl. Do not scrape Google SERPs.');
  }

  lines.push('');
  lines.push('Next: call lookup_provider_network with npi= the NPI above (and doctorName= official name) for the plan(s). True In/Out is NPI + carrier Find Care / FHIR / guest directory only.');

  return {
    text: lines.join('\n').slice(0, 7000),
    structured: {
      query,
      askedCarrier: carrier,
      records: merged,
      site: site
        ? {
            url: site.url,
            ok: site.ok,
            error: site.error || null,
            title: site.title || null,
            listed: site.listed || [],
            aliases: site.aliases || [],
          }
        : null,
    },
  };
}

module.exports = {
  KNOWN_CLINIC_SITES,
  CARRIER_PATTERNS,
  knownSiteFor,
  isBlockedSearchUrl,
  extractCarrierLogos,
  extractPageTitle,
  logoPhrase,
  formatSiteNotes,
  fetchClinicPage,
  searchClinicOrProvider,
};
