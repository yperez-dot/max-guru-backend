#!/usr/bin/env node
/**
 * Turn a pasted Max chat into a golden scenario (services/golden/scenarios/*.json).
 *
 *   node scripts/golden-from-chat.js chat.txt [--workup workup.json] [--name "Katy client 3 — …"] > services/golden/scenarios/x.json
 *
 * chat.txt: the chat as copied from Max. Turns start with "You:" / "Me:" / "Agent:" / "User:" (her) and "Max:" (Max);
 * with no markers the whole text is one message from her. A saved-workup banner in the paste ("Client: …",
 * "ZIP/county: …", "Plans:", "Doctors (names only …): …", "Medications …:") becomes the workup; --workup takes the
 * saved workup JSON instead. Max's last doctor grid / meds table fill doctorResults / drugResults (the stubbed
 * lookups), and expect is a snapshot of what the code does NOW — read it, fix what is wrong, then run
 * `node --test services/golden/golden.test.js`.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { file: '', workup: '', name: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workup') out.workup = argv[++i];
    else if (argv[i] === '--name') out.name = argv[++i];
    else out.file = argv[i];
  }
  return out;
}

const USER_RE = /^(?:you|me|agent|user|yahoska|katy|carolina|her)\s*:\s*/i;
const MAX_RE = /^max\s*:\s*/i;
function splitTurns(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (!lines.some((l) => USER_RE.test(l) || MAX_RE.test(l))) return [{ role: 'user', content: text.trim() }];
  const turns = [];
  for (const l of lines) {
    if (USER_RE.test(l)) turns.push({ role: 'user', content: l.replace(USER_RE, '') });
    else if (MAX_RE.test(l)) turns.push({ role: 'assistant', content: l.replace(MAX_RE, '') });
    else if (turns.length) turns[turns.length - 1].content += `\n${l}`;
  }
  return turns.map((t) => ({ ...t, content: t.content.trim() })).filter((t) => t.content);
}

const IDS = (t) => [...String(t || '').matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
function workupFromBanner(text) {
  const t = String(text || '');
  if (!/^Client:/m.test(t) || !/^Plans:/m.test(t)) return null;
  const plansBlock = (t.match(/^Plans:\s*\n((?:- .*\n?)+)/m) || [])[1] || '';
  const plans = plansBlock.split('\n').filter(Boolean).map((l) => {
    const id = IDS(l)[0];
    const name = l.replace(/^-\s*/, '').replace(/\s*\([HR]\d{4}-\d{3}[A-Z]?\)\s*$/i, '').trim();
    return id ? { carrier: name.split(/\s+/)[0], planName: name, planId: id } : null;
  }).filter(Boolean);
  const docLine = (t.match(/^Doctors \(names only[^)]*\):\s*(.+)$/m) || [])[1] || '';
  const npiLine = (t.match(/^Doctor NPIs[^:]*:\s*(.+)$/m) || [])[1] || '';
  const npis = Object.fromEntries([...npiLine.matchAll(/([^;]+?)\s+NPI\s+(\d{10})/g)].map((m) => [m[1].trim(), m[2]]));
  const medsBlock = (t.match(/^Medications[^\n]*:\s*\n((?:- .*\n?)+)/m) || [])[1] || '';
  return {
    clientName: ((t.match(/^Client:\s*(.+)$/m) || [])[1] || '').trim(),
    zip: ((t.match(/^ZIP\/county:\s*(\d{5})/m) || [])[1] || ''),
    county: ((t.match(/^ZIP\/county:\s*\d{5}\s*\/\s*(.+)$/m) || [])[1] || '').trim(),
    currentPlanIds: IDS((t.match(/^Current plan[^:]*:\s*(.+)$/m) || [])[1] || ''),
    plans,
    doctors: docLine.split(';').map((x) => x.trim()).filter(Boolean).map((name) => (npis[name] ? { name, npi: npis[name] } : { name })),
    medications: medsBlock.split('\n').filter(Boolean).map((l) => ({ name: l.replace(/^-\s*/, '').split(/:\s/)[0].trim() })),
  };
}

/** Max's newest doctor grid → { doctor: { npi, in, out } }; newest meds table → { med: { planId: { tier, cost } } }. */
function lookupsFromGrids(text) {
  const tables = [];
  let cur = null;
  for (const l of String(text || '').split('\n')) {
    const row = l.trim();
    if (/^\|/.test(row)) {
      // "| Doctor |" / "| Drug |" starts a new table even right under another one.
      if (!cur || /^\|\s*(?:doctor|drug)\s*\|/i.test(row)) { cur = []; tables.push(cur); }
      cur.push(row);
    } else cur = null;
  }
  const doctorResults = {};
  const drugResults = {};
  for (const tb of tables) {
    const head = tb[0].split('|').map((x) => x.trim());
    const ids = head.map((h) => IDS(h)[0] || '');
    const isDoc = /^doctor$/i.test(head[1]);
    const isDrug = /^drug$/i.test(head[1]);
    if (!isDoc && !isDrug) continue;
    for (const row of tb.slice(2)) {
      const cells = row.split('|').map((x) => x.trim());
      const label = cells[1] || '';
      if (!label || /^\*\*/.test(label)) continue;
      if (isDoc) {
        const npi = (label.match(/NPI\s*(\d{10})/) || [])[1];
        const name = label.split(/\s+·\s+/)[0].replace(/\s*⚠️.*$/, '').trim();
        const entry = { npi: npi || undefined, in: [], out: [] };
        cells.forEach((c, k) => { if (!ids[k]) return; if (/✅|\bIn\b/.test(c)) entry.in.push(ids[k]); else if (/❌|Not in network/i.test(c)) entry.out.push(ids[k]); });
        doctorResults[name] = entry;
      } else {
        const entry = {};
        cells.forEach((c, k) => {
          if (!ids[k]) return;
          if (/not covered/i.test(c)) entry[ids[k]] = 'not_covered';
          const m = c.match(/T(\d)\s*(\$[\d.,]+)?/);
          if (m) entry[ids[k]] = { tier: Number(m[1]), ...(m[2] ? { cost: m[2] } : {}), ...(/\bPA\b/.test(c) ? { pa: true } : {}), ...(/\bQL\b/.test(c) ? { ql: (c.match(/QL[^·|]*/) || ['QL'])[0].trim() } : {}) };
        });
        drugResults[label] = entry;
      }
    }
  }
  return { doctorResults, drugResults };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = fs.readFileSync(args.file || 0, 'utf8');
  const turns = splitTurns(text);
  const workup = args.workup ? JSON.parse(fs.readFileSync(args.workup, 'utf8')) : workupFromBanner(turns.map((t) => t.content).join('\n'));
  const userMsgs = turns.filter((t) => t.role === 'user' && !/^Client:/m.test(t.content)).map((t) => t.content);
  const lookups = lookupsFromGrids(turns.filter((t) => t.role === 'assistant').map((t) => t.content).join('\n\n'));
  const sc = {
    name: args.name || `${(workup && workup.clientName) || 'New client'} — TODO describe the case`,
    source: `pasted Max chat, ${new Date().toISOString().slice(0, 10)}`,
    review: 'TODO: check expect against what Max SHOULD do (it is a snapshot of what it does now), then delete this line',
    workup,
    messages: userMsgs,
    doctorResults: lookups.doctorResults,
    drugResults: lookups.drugResults,
    expect: {},
  };
  const { runScenario } = require(path.join(__dirname, '..', 'services', 'golden', 'harness'));
  const run = await runScenario(sc);
  sc.expect = {
    plans: run.sets.plans.map((p) => p.planId),
    gridPlans: run.job.result.planIds || [],
    doctors: run.sets.doctors,
    meds: run.sets.meds,
  };
  process.stdout.write(`${JSON.stringify(sc, null, 2)}\n`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { splitTurns, workupFromBanner, lookupsFromGrids };
