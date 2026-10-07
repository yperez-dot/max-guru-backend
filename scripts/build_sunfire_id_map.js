#!/usr/bin/env node
/**
 * Rebuild services/sunfire-id-map.json — the CMS contract-PBP → Sunfire plan id map that
 * services/formularyLookup.js uses to run drug lookups against a specific plan.
 *
 * Why this exists: the committed map was hand-collected, holds only 2026 ids, and records no
 * PBP — so matching fell back to searching for the CMS id inside the marketing name. Only
 * Humana prints it, so UHC, Aetna, Solis and Doctors never resolved and Sunfire was skipped
 * for them. Entries written here carry `pbp` and `year`, which is what makes matching work.
 *
 * Usage
 * -----
 *   SUNFIRE_JWT=... SUNFIRE_SFP=... node scripts/build_sunfire_id_map.js --year 2027
 *   node scripts/build_sunfire_id_map.js --year 2027 --from captured.json
 *   node scripts/build_sunfire_id_map.js --year 2027 --from captured.json --out /tmp/map.json
 *   ... --merge          keep existing entries for other years (default: replace the file)
 *   ... --dry-run        print what would be written, write nothing
 *
 * The --from path matters: Sunfire's plan-list endpoints have answered 404 for 2027
 * (Charlotte, 2026-10-07). When that happens, capture the plan list from a live Sunfire
 * session instead and feed the JSON in:
 *
 *   1. Sign in to Sunfire in Chrome and open a 2027 quote for any Florida ZIP.
 *   2. DevTools → Network → filter "plan" → click the request that returns the plan list.
 *   3. Right-click it → Copy → Copy response. Paste into captured.json.
 *   4. Run with --from captured.json.
 *
 * This script never prints or stores the JWT. Re-run when Sunfire publishes a new plan year
 * and commit the regenerated JSON.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SUNFIRE_BASE = process.env.SUNFIRE_BASE || 'https://api.sunfirematrix.com';
const OUT_PATH = path.join(__dirname, '..', 'services', 'sunfire-id-map.json');
const FETCH_TIMEOUT_MS = 20_000;

// Endpoint shapes seen across Sunfire plan years; the first that answers with a list wins.
const PLAN_LIST_PATHS = (year, state) => [
  `/v2/plan/list/${year}`,
  `/v2/plan/search/${state}/${year}`,
  `/v2/plans/${year}`,
  `/v2/plan/${year}/list`,
  `/v1/plan/list/${year}`,
];

function parseArgs(argv) {
  const args = { year: null, from: null, out: OUT_PATH, merge: false, dryRun: false, state: 'FL' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--year') args.year = Number(argv[++i]);
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--state') args.state = String(argv[++i] || 'FL').toUpperCase();
    else if (a === '--merge') args.merge = true;
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function sunfireHeaders() {
  const jwt = process.env.SUNFIRE_JWT || '';
  const sfp = process.env.SUNFIRE_SFP || '';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SUNFIRE_BASE,
    Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
    'User-Agent': 'Max-Medicare-Guru/1.0',
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (sfp) headers.Cookie = `sfp-cookie=${sfp}`;
  return headers;
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: sunfireHeaders(), signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, json: null };
    return { ok: true, status: res.status, json: await res.json().catch(() => null) };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the plan array out of whatever envelope Sunfire (or a captured response) uses. */
function planArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['plans', 'results', 'data', 'items', 'planList']) {
    const v = payload[key];
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.plans)) return v.plans;
  }
  return [];
}

/**
 * CMS contract + PBP for one plan record. Sunfire spells these several ways across
 * endpoints, and some records only carry the id inside the marketing name.
 */
function cmsPartsOf(plan) {
  const contract = String(
    plan.contractId || plan.contractNumber || plan.hNumber || plan.hRaw || plan.contract || ''
  ).toUpperCase().match(/^[HRS]\d{4}/)?.[0] || null;
  // Sunfire's plan-list records carry the PBP in `planId` ("054") while the Sunfire plan id
  // lives in `id` ("262355"). Only treat planId as a PBP when it is short and numeric, so a
  // record that uses planId as the Sunfire id is not misread (Yahoska capture, 2026-10-07).
  const shortPlanId = /^\d{1,3}$/.test(String(plan.planId ?? '')) ? plan.planId : null;
  const rawPbp =
    plan.pbp ?? plan.pbpId ?? plan.planBenefitPackage ?? plan.pbpNumber ?? plan.segmentPbp ?? shortPlanId;
  let pbp = rawPbp == null || rawPbp === '' ? null : String(rawPbp).replace(/\D/g, '').padStart(3, '0');

  if (!contract || !pbp) {
    const blob = `${plan.cmsPlanId || ''} ${plan.planId || ''} ${plan.name || plan.planName || ''}`.toUpperCase();
    const m = blob.match(/([HRS]\d{4})-?(\d{3})([A-Z])?/);
    if (m) return { contract: contract || m[1], pbp: pbp || m[2], letter: m[3] || '' };
  }
  // segmentId is numeric in the plan list ("000"); the CMS letter, when there is one, only
  // shows up inside the marketing name ("… H1036-054C (HMO)").
  const nameLetter = String(plan.name || plan.planName || '')
    .toUpperCase()
    .match(/[HRS]\d{4}-\d{3}([A-Z])/)?.[1] || '';
  const letter = String(plan.suffix || '').toUpperCase().match(/^[A-Z]$/)?.[0] || nameLetter;
  return { contract, pbp, letter };
}

function sunfireIdOf(plan) {
  const id = plan.id ?? plan.planId ?? plan.sunfireId ?? plan.sunfirePlanId ?? plan.key;
  const s = String(id == null ? '' : id).trim();
  return /^\d{4,}$/.test(s) ? s : null;
}

function buildEntries(plans, year) {
  const map = {};
  let skipped = 0;
  for (const plan of plans) {
    const sfId = sunfireIdOf(plan);
    const { contract, pbp, letter } = cmsPartsOf(plan);
    if (!sfId || !contract || !pbp) {
      skipped += 1;
      continue;
    }
    map[sfId] = {
      hRaw: contract,
      pbp,
      letter: letter || undefined,
      planName: String(plan.name || plan.planName || '').trim(),
      carrier: String(plan.carrier || plan.carrierName || plan.brandName || plan.organizationName || '').trim(),
      year,
    };
  }
  return { map, skipped };
}

async function fetchPlans(year, state) {
  if (!process.env.SUNFIRE_JWT) {
    throw new Error('SUNFIRE_JWT is not set. Export it, or capture the plan list and use --from.');
  }
  const tried = [];
  for (const p of PLAN_LIST_PATHS(year, state)) {
    const res = await getJson(`${SUNFIRE_BASE}${p}`);
    tried.push(`${p} → ${res.status || res.error}`);
    const plans = planArray(res.json);
    if (res.ok && plans.length) {
      console.error(`Plan list from ${p} (${plans.length} plans)`);
      return plans;
    }
  }
  throw new Error(
    `No Sunfire plan-list endpoint answered for ${year}:\n  ${tried.join('\n  ')}\n` +
      'Capture the plan list from a live Sunfire session and re-run with --from <file.json> ' +
      '(see the header of this script).'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.year) {
    console.error('Pass --year, e.g. --year 2027');
    process.exit(2);
  }

  const plans = args.from
    ? planArray(JSON.parse(fs.readFileSync(args.from, 'utf8')))
    : await fetchPlans(args.year, args.state);

  if (!plans.length) throw new Error('No plans found in the response.');

  const { map, skipped } = buildEntries(plans, args.year);
  const count = Object.keys(map).length;
  if (!count) throw new Error(`Parsed ${plans.length} records but none had a Sunfire id + CMS contract/PBP.`);

  let out = map;
  if (args.merge && fs.existsSync(args.out)) {
    const existing = JSON.parse(fs.readFileSync(args.out, 'utf8'));
    // Additive by Sunfire id: plan lists are scoped to the quote's ZIP, so several captures
    // per year are normal and each one adds that county's plans. Newly captured entries win
    // on conflict (Yahoska, 2026-10-07).
    out = { ...existing, ...map };
    const added = Object.keys(map).filter((id) => !(id in existing)).length;
    console.error(`${added} new, ${Object.keys(map).length - added} refreshed`);
  }

  const carriers = new Set(Object.values(map).map((e) => e.carrier).filter(Boolean));
  console.error(
    `${count} plans mapped for ${args.year} (${carriers.size} carriers)` +
      `${skipped ? `, ${skipped} records skipped (no id or no CMS contract/PBP)` : ''}`
  );

  if (args.dryRun) {
    console.error('--dry-run: nothing written.');
    console.log(JSON.stringify(Object.fromEntries(Object.entries(out).slice(0, 5)), null, 2));
    return;
  }
  fs.writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  console.error(`Wrote ${Object.keys(out).length} entries → ${args.out}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
