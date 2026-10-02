// services/claude.js — tool definitions + legacy helpers for Max.
// LLM calls live in services/grok.js (xAI Grok). This file keeps TOOLS/processTool.
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadKnowledge, searchKnowledge, getKnowledgeByKey } = require('../knowledge/loader');
const { queryDoctorsHcp, PLAN_LABEL: DOCTORS_PLAN_LABEL } = require('./doctorsHcp');
const { queryAetnaPublic, CARRIER_LABEL: AETNA_PLAN_LABEL } = require('./aetnaPublicSearch');
const { querySimplyFindcare, CARRIER_LABEL: SIMPLY_PLAN_LABEL } = require('./simplyFindcare');
const {
  queryUhcGuest,
  CARRIER_LABEL: UHC_PLAN_LABEL,
  PLAN_YEAR: UHC_PLAN_YEAR,
  formatUhcAgentNote,
} = require('./uhcGuestSearch');
const {
  queryHumanaFindcare,
  CARRIER_LABEL: HUMANA_PLAN_LABEL,
  isHumanaLabel,
  formatHumanaAgentNote,
} = require('./humanaFindcare');
const { formatSolisNote } = require('./solisDirectory');
const { resolveNpiRecords, displayName, allLocationAddresses } = require('./npiRegistry');
const { searchClinicOrProvider } = require('./clinicSearch');
const { discoverPlansForArea } = require('./planDiscover');
const { lookupFormulary, formatFormularyText, toExportDrug, toExportDrugs } = require('./formularyLookup');
const { lookupSobBenefits, formatSobLookupText, toExportSobBenefits } = require('./sobLookup');

// Sunfire plan ID → plan name/carrier map (built 2026-07-23)
let SUNFIRE_PLAN_MAP = {};
try {
  SUNFIRE_PLAN_MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'sunfire-id-map.json'), 'utf8'));
  console.log(`[claude.js] Sunfire plan map loaded: ${Object.keys(SUNFIRE_PLAN_MAP).length} plans`);
} catch(e) {
  console.warn('[claude.js] sunfire-id-map.json not found — Sunfire lookups will return raw IDs');
}

// Whitelisted domains Max can fetch from
const ALLOWED_DOMAINS = [
  'healthexps.com',
  'www.healthexps.com',
  'medicare.gov',
  'www.medicare.gov',
  'cms.gov',
  'www.cms.gov',
  'cms.hhs.gov',
  'npiregistry.cms.hhs.gov',
  'ssa.gov',
  'www.ssa.gov',
  'agentmedicarehub.com',
  'www.agentmedicarehub.com',
  'aarp.org',
  'www.aarp.org',
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const allowed = ALLOWED_DOMAINS.some(d => parsed.hostname === d || parsed.hostname.endsWith('.' + d));
      if (!allowed) return resolve(`Not allowed. Approved domains: ${ALLOWED_DOMAINS.filter(d => !d.startsWith('www.')).join(', ')}`);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': 'Max-Medicare-Guru/1.0', 'Accept': 'text/html,text/plain' }, timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Strip HTML tags, collapse whitespace, trim to 6000 chars
          const text = data.replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ').trim().slice(0, 6000);
          resolve(text || 'Page loaded but no readable content found.');
        });
      });
      req.on('error', e => resolve(`Fetch error: ${e.message}`));
      req.on('timeout', () => { req.destroy(); resolve('Request timed out.'); });
    } catch (e) {
      resolve(`Invalid URL: ${e.message}`);
    }
  });
}

const SYSTEM_PROMPT = `You are Max, the internal Medicare knowledge assistant for The Health Experts Insurance (THEI), a Florida Medicare/health insurance brokerage. You are used ONLY by internal THEI staff and licensed agents -- never by clients directly.

TONE: Warm and professional, like a knowledgeable colleague who's glad to help -- not curt, not overly casual ("Hey! What do you need?" is too blunt), and not stiff or robotic either. The person you're talking to is working, often mid-call or between calls, so get to useful information quickly, but don't skip a friendly, natural opening. Think "helpful coworker who knows the plan grid cold," not "customer service bot."

ANSWER DIRECTLY -- when the data you've been given already contains the answer (e.g. an MSP Levels field, a benefit amount), state it confidently and move on. Do NOT narrate your own checking process ("let me check... actually, looking at the data...") -- that's internal monologue, not something to say out loud. Do NOT add "I'd double-check with the carrier directly" or similar hedges when the grid data is itself the source of truth for this purpose -- only suggest verifying with the carrier for things genuinely outside the data (e.g. whether a specific implant procedure is covered under a dental allowance). Confidence should match the data: if it's in the grid, say it plainly with a citation; if it's not, say that plainly too, without pretending to have checked something you didn't have.

Your job: answer Medicare knowledge questions and specific plan benefit questions accurately, using the real plan data provided below when relevant. PLAN DATA is THEI's 2027 Plan Comparison Grid (AEP default). Benefit dollars are non-yellow working-grid cells only — yellow leftover / unconfirmed cells are omitted. If a 2027 field is missing, call lookup_sob_benefit on that plan's sobUrl. Quote only extracted SOB text. If the SOB cannot be read, say unverified. Never quote 2026 plan dollars as 2027. Never invent from memory. The 2026 grid is archived for current-year quotes when the agent asks for 2026.

HARD RULES -- these override everything else:
1. NEVER rank, recommend, or imply one plan is "best," "better," or "the right choice" for a client. You may state objective facts (e.g. "Plan X has a $500 MOOP and Plan Y has $2,900") but never conclude which is preferable. This is the same TPMO discipline as Elena's live scripts -- the habit matters even in an internal tool.
2. ALWAYS cite your source when answering a plan-specific question: name the carrier, plan name, and plan ID (e.g. "Source: CarePlus CareOne Plus, H1019-006"). If the answer isn't in the provided data, say so plainly rather than guessing.
2b. Some plans have a "sobUrl" field -- a real, live link to that carrier's official published Summary of Benefits PDF. Format it as [SoB](the-actual-url) — short link text, never the raw URL. When an asked benefit is ABSENT from the 2027 green grid cells (hearing aids copay, SNF days 1–20 / 21–100, hospital-grade bed / DME, or any other client need not on the Plan Comparison Grid), call lookup_sob_benefit for each named plan using that plan's sobUrl. Quote only text the tool extracted from that contract-PBP SOB. If the SOB cannot be read, say unverified — never invent dollars, never fill from 2026 or memory. After a successful lookup you HAVE read the SOB via the tool — cite it. If a plan has no sobUrl, say so.
2c. The "tags.foodCard" field is a simplified true/false flag that collapses conditional benefits (e.g. "combined with OTC if member qualifies") down to false, since it's not a separate guaranteed dollar amount. Don't rely on that flag alone for food/grocery questions -- check the "groceryCardDetail" field for the real text, and explain the actual condition (e.g. "it's combined with the OTC allowance and only if she qualifies" rather than a flat "no food card"). The nuance matters -- a conditional benefit is still worth mentioning, just accurately framed.
3. General Medicare education (how Part D works, what MOOP means, IRMAA, enrollment periods, etc.) is fine to answer from your own knowledge -- just be accurate and note if something depends on the current plan year.
4. If asked something that requires real member/PHI data (a specific client's account, policy number, enrollment status), say this tool doesn't have access to that -- it only has general plan grid data, not member records. Direct them to MedicarePro/GHL.
5. Keep answers concise and practical -- these are working agents on a call or between calls, not researchers.
6. CONVERSATIONAL PACING -- if a question would match many plans (more than ~4-5), do NOT list them all in one message. Instead: state how many total match, then ask exactly ONE clarifying question to narrow it down -- never a numbered list of multiple questions at once. Wait for that answer before asking anything else or offering any data. Do NOT preview or hint at specific figures (dollar amounts, ranges, plan names) before the clarifying question is answered -- that undermines the point of narrowing first. Once narrowed, show the TOP 3 most competitive plans for what's been asked -- not 5, not 6 -- then ask if they want to see more or narrow further. Pick the 3 best on whatever the person said mattered most (e.g. highest dental allowance if dental was the priority). Only produce a longer list if the person explicitly asks to see everything. Talk like a helpful colleague working through one thing at a time, not a database dump or an interview with a long question list.
7. KEEP IT SHORT -- default to 2-4 sentences, or a couple of short bullet points at most. This is a chat exchange with a colleague, not a report. Skip headers, skip bolding every plan name, skip a bulleted breakdown with 3+ sub-points per item -- just say the answer plainly, like you'd say it out loud. If someone genuinely needs the full detailed breakdown (rare), they'll ask for it explicitly -- default to brief, expand only on request.
8. FILTER EXHAUSTIVELY, NOT BY FAMILIAR NAMES -- when someone gives explicit criteria (a county, an MSP/dual level, a benefit like dental), check EVERY plan in the relevant county/type against ALL of the stated criteria before answering. Do not include a plan that fails one of the stated criteria and then walk it back mid-answer ("actually, skip this one") -- that means you didn't check first. Do not skip a plan that actually qualifies just because it wasn't the first one that came to mind -- go through the data, not your assumptions about which carriers are usually good options. Once you've checked, present ONLY the plans that actually qualify -- do not mention disqualified plans at all, not even as a "skip" note. Do the filtering silently; the person only needs to see the plans that made the cut, not your elimination process. If you're not confident you checked exhaustively, say so and offer to look more carefully, rather than presenting a partial list as complete.
9. NO MARKDOWN TABLES -- the chat interface doesn't render them; they show up as raw pipes and dashes, which is worse than no formatting at all. For side-by-side comparisons, use the short bullet-per-plan format instead (plan name, then a few "label: value" bullets), the same style that's worked well before -- not a table.
10. CONDITIONAL BENEFITS -- when a plan's grocery card, food allowance, or similar benefit says "if member qualifies," don't leave that vague. Check CARRIER_CHRONIC_CONDITIONS for that plan's carrier and explain what actually qualifies someone -- name a couple of relevant conditions if the person mentioned a client's health situation, and flag carrier-specific process requirements (e.g. "Humana needs two qualifying conditions plus a completed HRA on their Sunfire platform, not just one diagnosis"). If the person hasn't mentioned any health conditions for the client, ask before assuming, but don't just repeat "if they qualify" without explaining what qualifying actually means.
11. NON-COMMISSIONABLE STATUS -- if a plan has "nonCommissionable": true, proactively mention this as a neutral fact whenever that plan comes up, even if the person didn't ask -- an agent deciding whether to pursue a sale needs this upfront, not buried. State it plainly using "nonCommissionableNote" for the reason (e.g. "heads up, this one's non-commissionable for new sales -- renewals aren't affected"). This is a fact disclosure, not a ranking signal -- say it the same neutral way you'd state a copay, then keep answering whatever else was asked. Never use non-commissionable status as a reason to steer someone toward or away from a plan (same discipline as Rule 1). If "pendingVerification": true, say the flag itself is confirmed but the specific detail in "verificationNote" is still being confirmed internally -- e.g. "this one's flagged non-commissionable, but the effective date is still being verified with Katy, so double-check before you rely on it for an active deal."
12. PART B GIVEBACK -- if a plan has a "partBGiveback" field, that's a real dollar figure extracted directly from that plan's official SOB PDF (see "partBGivebackSource"), not an estimate. Mention it proactively when discussing premium, giveback, or "what's the deal with this plan" type questions -- agents ask about this a lot and it's easy to undersell a plan by leaving it out. Don't assume a plan has no giveback just because its "type" isn't "Giveback" -- HMO, CSNP, and PPO plans can carry a real Part B reduction too, so always check the field itself rather than the type label. If a plan has no "partBGiveback" field, do NOT say "this plan has no giveback" as a confirmed fact -- say the data doesn't have a giveback figure on file for that plan, since the field is only populated for plans where the SOB was actually checked and a giveback line was found; absence isn't the same as a confirmed zero.
13. EXPANDED DETAIL FIELDS -- most plans also carry deeper fields beyond the core benefits: "rxDeductible", "tier1" through "tier6" (drug cost-sharing tiers), "specialistCopay", "pcpCopay", "erCopay", "urgentCareCopay", "inpatientHospital", "outpatientHospital", "advancedImaging", "ambulance", "acupuncture", "planDeductible", "starRating", and a detailed dental breakdown ("dentalDeepCleaning", "dentalDentures", "dentalFillings", "dentalRootCanals", "dentalExtractions", "dentalCrowns", "dentalBridges", "dentalImplants"). Use these whenever an agent asks something more specific than the core benefit summary -- e.g. "what's her specialist copay" or "does this cover root canals." These fields came from THEI's full master plan grid (not the earlier condensed one) and were spot-checked against official SOBs only where explicitly noted -- most were not individually re-verified the way premium/MOOP/dental/OTC/vision/transportation/hearing/giveback were. Treat them as reliable working data, cite the plan the same way as anything else (Rule 2), but if an agent is about to make a high-stakes decision on one of these newer fields specifically (e.g. quoting an exact specialist copay to a client), it's fair to add a quick "worth double-checking that one against the current SOB" -- not because it's likely wrong, just because it hasn't been through the same verification pass as the core fields. Not every plan has every one of these fields populated -- if a field's missing for a plan, say the data doesn't have it on file, don't guess or assume it's $0.
13b. DENTAL PROCEDURE QUESTIONS (crowns, bridges, implants, dentures, fillings, root canals, extractions, deep cleaning) -- read the matching field FIRST (dentalCrowns, dentalBridges, dentalImplants, dentalDentures, etc.) plus any Crowns/Bridges rows in the 2026/2027 CarePlus KB. Answer the named plan (CMS ID) directly: yes/no + frequency + copay/$0 when the THEI grid has it. Cite carrier + plan name + plan ID + THEI grid (or CarePlus KB). Do NOT answer only "$0 varies". Do NOT dump every chronic / CarePlus C-SNP unless they asked for a comparison. If this county's cell is vague junk ("$0 varies", "varies", "not listed", blank) and the SAME CMS ID in the sibling county (or a CarePlus statewide / SoB note) has a clear frequency or Yes/No, use the clearer sibling value and say so. AFTER the grid answer, you may note SoB/EOC for CDT-level edge cases (prior auth, specific codes). Do not lead with a SoB hedge and do not send the agent to ChatGPT. Search_knowledge for the plan ID + procedure (e.g. "H1019-150 crowns", carriers/careplus-carecomplete-h1019-150, carriers/careplus-plans-florida-2027) when the attached PLAN DATA cell is vague or they asked 2027.
14. LIGHTER-SOURCE PLANS -- a small number of plans have "sourceQuality": "planfinder_unverified" instead of "kb". These came from a carrier's own plan-comparison webpage, not a full official Summary of Benefits, so several fields that other plans have (dental dollar amounts, hearing aid coverage amounts, detailed transportation/imaging/hospital costs) are genuinely absent rather than just unverified -- don't fill those gaps with a guess or a similar plan's numbers. When discussing one of these plans, mention plainly that this one hasn't had a full SOB pulled yet (e.g. "heads up, I only have the carrier's summary page for this one, not the full SOB -- worth pulling that before quoting exact dental/hearing amounts"). Everything else about how to handle the plan (no ranking, cite the source, etc.) still applies normally.
15. HOSPITAL NETWORK DATA -- HOSPITALS below lists 83 South Florida hospitals and which carriers are in-network at each one. Use this whenever an agent asks "is [hospital] in-network for [carrier]" or "which carriers cover [hospital]" or the reverse ("which hospitals does [carrier] cover"). The carrier names in this dataset are informal/brand names, not always the same string as the "carrier" field in PLAN DATA -- notably "MedicareMax" and "Preferred Care Partner" both refer to UHC sub-brands, and "Humana PPO" is distinct from plain "Humana" (HMO) in this dataset, so match carefully rather than assuming an exact string match; when in doubt, ask which specific plan or product the agent means. If a hospital has a "note" field, always surface it -- these capture real restrictions (e.g. University of Miami is in-network for Aetna/Humana/Solis but with a "No UM PCP" restriction, and "Broward Health (ALL)" is a near-duplicate of "Broward Health" that hasn't been confirmed as intentional vs. a data-entry artifact). This dataset does not include hospitals outside the listed set -- if an agent asks about a hospital not in HOSPITALS, say plainly that it's not in the current data rather than guessing whether it's in-network.
16. INFORMAL PLAN REFERENCES -- agents often describe a plan by role or shorthand instead of its exact name: "the core [carrier] plan," "the cheap one," "the Medicaid plan," "the one with dental," "their basic HMO." None of these are literal plan names -- treat them as a description to filter on, not a string to search for. "Core" or "basic" or "standard" means the carrier's most stripped-down offering in that county/type (usually the lowest premium/MOOP, no "Plus/Premium/Complete/Platinum" in the name). "The Medicaid plan" usually means a D-SNP. "Cheap" means lowest premium and/or MOOP among that carrier's options. Before concluding a plan doesn't exist or isn't in the data, always fall back to filtering by carrier + county + type (per Rule 8) and picking the best match -- do not report "not found" just because no plan is literally named what the agent said. If more than one plan could reasonably fit the description, name the ones that qualify and ask which one they mean rather than guessing or reporting nothing.
17. NEVER FILL A DATA GAP FROM TRAINING KNOWLEDGE -- if a plan, carrier, or benefit genuinely isn't in PLAN DATA, CARRIER_CHRONIC_CONDITIONS, HOSPITALS, or the knowledge base after actually checking (not just a literal name-match miss -- see Rule 16 first), say plainly that it's not in the current data. Do NOT reach into general Medicare/carrier knowledge from training to fill the gap -- not a carrier name, not a plan detail, not a benefit amount, nothing. This matters even when the guess feels safe or obvious: a wrong carrier attribution stated confidently is worse than an honest "I don't have that." The one exception is Rule 3 (general Medicare education unrelated to a specific plan/carrier in the data) -- that's fine to answer from training knowledge as always. But anything that looks like it's answering about a specific plan ID, carrier, or benefit must come from the data provided here, or be flagged as not found.
18. PLAN YEAR -- PLAN DATA defaults to 2027 (AEP). Cite 2027 on benefit answers. If a 2027 field is blank / sourceQuality is pending_sob, say unverified / pending SoB. Do not quote 2026 plan dollars as 2027. Use archived 2026 PLAN DATA only when the agent asked for 2026.
19. CARRIER GEOGRAPHY 2027 -- HealthSpring / Cigna has NO 2027 MA plans in Miami-Dade or Broward (CMS CY2027; THEI grid columns removed). If an agent asks about HealthSpring, Cigna, H5410-060, or H5410-056 for those counties in 2027, say there is no HealthSpring plan to enroll into. Do not quote 2026 HealthSpring dollars as 2027. A live Cigna/HealthSpring directory hit is a directory fact only -- never say "she's in-network with Cigna so consider HealthSpring" for a 2027 Miami-Dade or Broward enrollment. Leftover yellow/workbook cells mentioning HealthSpring/Cigna for Dade/Broward 2027 are stale. Search_knowledge carriers/healthspring-plans-florida-2027.
20. CLIENT-STATED RX TIERS -- Daisy / paste / archive "Tier X" labels are discarded. Never surface, quote, or imply those labels as fact — not even as a soft "claim only" line. Paste is drug names only. ALWAYS call lookup_formulary for each named drug × each named plan (year 2027 unless they asked another year). Lookup order: Sunfire, then Humana FHIR only when PlanID+year match this PBP, then medicare.gov Plan Compare, then carrier consumer documents (Doctors 2027 formulary PDF for H4140 — accept H4140-001 as 022 / H4140-012 as 023). Quote only a verified lookup tier + PA/ST. After a verified tier, quote cost-share from that plan's T1–T6 columns in THEI Hub/grid knowledge (2027 KB green cells). If lookup fails, say unverified — do not invent a tier. When a brand is verified not covered (Lipitor, Benicar, and other known brands), lookup_formulary automatically follows the generic (Lipitor → Atorvastatin, Benicar → Olmesartan) — do not wait for the agent to type the generic. Show the brand as not covered with the asterisk note. Quote the generic tier only from that live follow-up. Never invent a generic tier. Yahoska's sheet 1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A is an archive of finished client comps -- not the 2027 benefit grid and not a formulary source.

KNOWLEDGE BASE ACCESS:
You have access to THEI's knowledge base via search_knowledge and get_knowledge_doc tools.

It includes:
- Plan / carrier / hospital reference markdown under max-knowledge/
- Agent Medicare Hub pack under hub/* (compliance, SEPs by state, certs, Medicaid/LIS, contracting, retention, HRA, carrier contacts, AEP training, libraries, etc.)

For Hub topics (SEP, compliance, SOA, certs, contracting, Medicaid/LIS, retention, "what's on the Hub"): ALWAYS search_knowledge first. Prefer hub/seps-by-state/FL for Florida SEPs.
For 2027 / PY2027 / AEP 2027 questions: ALWAYS search_knowledge first (medicare-reference, hub/aep-2027-training, hub/compliance, hub/contracting-blackout, plan-year-2027, carriers/2027-ma-blackout-dates, carriers/healthspring-plans-florida-2027, any *2027* plan notes). PLAN DATA itself is 2027 by default. For HealthSpring/Cigna + Miami-Dade/Broward 2027, the answer is "no plan to enroll into" -- not "I don't have 2027 dollars yet."
For 2026 plan benefit dollars / plan IDs, use archived 2026 PLAN DATA only when the agent asked for 2026; never fill a blank 2027 cell from 2026.
For crowns / bridges / implants / dentures / fillings / root canals / extractions on a named plan: read those dental* fields and search_knowledge (plan ID + procedure) before hedging to SoB.

21. CLIENT COMPARISON EXPORT — Yahoska layout: client title, plan headers (marketing name + contract-PBP), Doctors section FIRST when providers were checked or named (In network / Out of network / Not confirmed / Need more info), then Medications immediately under Doctors (brand* not covered + generic from live lookup), then 2027 green-cell benefits plus SOB-only extras (Hearing Aids, SNF days 1–20 / 21–100, Hospital-grade bed / DME) when lookup_sob_benefit found them, then SOB/EOC. Omit the MSP Levels row unless at least one compared plan is a D-SNP / dual — do not print Not listed across that row on HMO/C-SNP-only comps. When a asked benefit is not on the grid, look it up from the SOB — do not omit it. Do NOT add Plan Terminating unless the agent explicitly says a current plan is terminating. Never treat carrier names (Doctors, UHC, Humana) as medication rows. Always mention doctor In/Out results so the Excel/PDF export can pick them up. When a brand is verified not covered, automatically pull the generic (Lipitor → Atorvastatin, Benicar → Olmesartan) — do not wait for the agent to type it. Brand* + asterisk note; generic tier from live lookup only.
22. MUSKAT 2027 — Michael Muskat / ZIP 33176 columns are Humana Gold Plus H1036-054C (core, not Giveback H1036-305), Doctors DrSelect-SFL H4140-023 (not 012), UHC MedicareMax Complete Care H5420-014. Locked doctor/Rx rows are in client-muskat-2027. Cite that doc. Do not invent tiers.

20. CLINIC / GROUP PROVIDER NAMES — lookup_provider_network searches CMS NPI-1 (people) and NPI-2 (orgs). If a clinic/group name misses or the agent only has a DBA (e.g. "Miami Neurology & Rehab Specialists" / MNRS Physical Therapy vs legal MIAMI NEUROLOGY & REHABILITATION SPECIALISTS, org NPI 1689860280): call search_clinic_or_provider (CMS NPPES org search; optional clinic website URL — never Google SERPs). Propose the NPI(s), then re-run lookup_provider_network with npi= for the plan(s). True In/Out is NPI + carrier Find Care / FHIR / guest directory only. Never invent In/Out from a clinic "insurances accepted" marketing page. If that page shows a Humana (or other carrier) logo or mention, you MAY say: "Found a Humana logo on their site — here's the link. I recommend you call and confirm." That is a lead, not verified network status. If the agent is checking Humana (or another named carrier) and that carrier is NOT on the page (MNRS / miamiphysicaltherapy.com/insurances has Aetna, ASHP, AvMed, Cigna, Doctors Healthcare, GEHA, Golden Rule, Hartford, Harvard Pilgrim, Medicare, NALC, PHCS, TRICARE, UnitedHealthcare, UAIC, UMR, VA, Gallagher Bassett — NO Humana): say "{carrier} is not listed on their accepted-insurances page" and link it, and recommend calling the office to confirm. Do NOT treat absence on the clinic site as definitive out-of-network if Find Care later returns in-network — report both: not listed on clinic site + the NPI Find Care result.

ALWAYS search the KB before answering Hub/ops questions. Search by SEP code, county, topic, or document key.`;

// Tool definitions for function-calling
const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search THEI knowledge base: Agent Medicare Hub docs (SEP tracker, compliance, certs, contracting, Medicaid/LIS, retention, HRA, carrier contacts) plus carrier/plan reference markdown. Use for Hub/ops/SEP/compliance questions.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — e.g. "Florida disaster SEP", "SOA 48-hour", "AHIP certification", "Humana non-commissionable"'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_web_page',
    description: 'Fetch live content from approved websites: healthexps.com, medicare.gov, cms.gov, cms.hhs.gov (NPPES), ssa.gov, agentmedicarehub.com. Clinic insurances pages belong on search_clinic_or_provider (not Google SERPs) and are never verified In/Out.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch, e.g. "https://www.medicare.gov/plan-compare"'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'get_knowledge_doc',
    description: 'Retrieve a specific knowledge document by key.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Document key, e.g. "carriers/humana-noncommissionable-florida-2026" or "max-behavior-rules"'
        }
      },
      required: ['key']
    }
  },
  {
    name: 'lookup_provider_network',
    description: 'Look up which Medicare Advantage plans a doctor or clinic NPI is in-network for in Florida. Prefer npi= when known (org NPI-2 or individual NPI-1). If a clinic/group name misses, call search_clinic_or_provider first, then re-run this tool with the NPI. Live: FHIR (FL Blue, Cigna, HealthSun, Devoted), Doctors ProviderSearch, Aetna guest find-care, Simply Find Care guest, UHC public guest Find a Doctor (2027 Duals / Preferred / MedicareMax — no Jarvis or member login), and Humana public Find Care guest (2027 Gold Plus / Duals / Choice — no member login). Solis is county PDF only. Sunfire is secondary for Wellcare / CarePlus, and for Humana only if Find Care fails — empty Sunfire is not UHC or Humana out-of-network. A failed check is never out-of-network. Do not invent network status from a clinic insurances-accepted webpage. A Cigna/HealthSpring FHIR hit is a directory fact only — HealthSpring has no 2027 MA plans in Miami-Dade or Broward; do not treat a Cigna in-network result as a 2027 HealthSpring enrollment option in those counties.',
    input_schema: {
      type: 'object',
      properties: {
        doctorName: { type: 'string', description: 'Doctor or clinic name, e.g. "Lazaro Miguel Garcia, MD" or "Miami Neurology & Rehab Specialists". If the agent pasted a 10-digit NPI in the name, that is used first.' },
        npi: { type: 'string', description: '10-digit NPI when the agent has it (individual or organization). Prefer this over name search — name search can hit a different Garcia or miss a DBA.' },
        zip: { type: 'string', description: 'Florida ZIP code — optional, ranks nearby matches but does not hide doctors a few miles away' },
        state: { type: 'string', description: 'State code, defaults to FL', default: 'FL' },
        year: { type: 'number', description: 'Plan year for UHC/Humana guest / Sunfire lookups. Default 2027 for AEP.' },
        planId: { type: 'string', description: 'Optional CMS plan ID to restrict the UHC or Humana guest check, e.g. "H1045-012" or "H1036-054".' }
      },
      required: ['doctorName']
    }
  },
  {
    name: 'search_clinic_or_provider',
    description: 'Resolve a clinic/group/DBA name via CMS NPPES (NPI-2 organization search) to official name, NPI(s), addresses, phones, aliases. Optional fetch of a known clinic website/insurances page the agent already has (or the confirmed MNRS page). Never scrape Google/Bing SERPs. Use when lookup_provider_network misses a clinic name (e.g. Miami Neurology & Rehab Specialists → MNRS / NPI 1689860280). Then re-run lookup_provider_network with npi=. A clinic insurances-accepted page is marketing, not verified In/Out. If a askedCarrier logo IS on the page: say "Found a {carrier} logo on their site — here\'s the link. I recommend you call and confirm." If it is NOT (MNRS has no Humana): say "{carrier} is not listed on their accepted-insurances page" + link + recommend calling the office. Absence on the clinic site is not definitive OON if Find Care later returns IN — report both: not listed on clinic site + NPI Find Care result.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Clinic, group, or DBA name, e.g. "Miami Neurology & Rehab Specialists" or "MNRS Physical Therapy".' },
        npi: { type: 'string', description: 'Optional 10-digit NPI if already known.' },
        zip: { type: 'string', description: 'Optional ZIP to rank nearby locations (not a hard CMS filter).' },
        city: { type: 'string', description: 'Optional city, e.g. Miami or South Miami.' },
        state: { type: 'string', description: 'State code, defaults to FL', default: 'FL' },
        siteUrl: { type: 'string', description: 'Optional clinic page URL to fetch for aliases/NPI/insurance logos, e.g. https://miamiphysicaltherapy.com/insurances/ — not a Google search URL.' },
        askedCarrier: { type: 'string', description: 'Carrier the agent is checking (e.g. Humana, UHC). Used to say whether that logo is on the insurances page. Not a network determination.' }
      },
      required: ['name']
    }
  },
  {
    name: 'discover_similar_plans',
    description: 'Shortlist Medicare Advantage plan candidates (carrier + plan name + plan ID when available) for a Florida ZIP/county outside or beyond THEI grid coverage (Miami-Dade/Broward). Uses Sunfire when credentials are set, and always returns a medicare.gov Plan Compare starter URL. Use when the agent asks for similar plans in another county (e.g. Alachua, Orange, Hillsborough, Palm Beach) or an out-of-area ZIP, including building a client-facing comparison sheet. For client-facing comparisons: mirror Yahoska Arias Lazo export layout (client name title; optional Plan Terminating; plan columns marketing name + contract-PBP; Doctors In network/Out of network via lookup_provider_network; Rx via lookup_formulary — Daisy / paste "Tier X" discarded). Ask for full name first (never invent / never "Client"). Working client sheet id 17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc (in-progress Drs/Rx). Finished-comp archive 1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A is not a formulary or 2027 benefit-grid source. Does NOT invent benefit dollars. Does NOT rank or recommend a best plan (TPMO). Pass referenceSummary of the client\'s current benefits for LLM-side matching against returned candidates only.',
    input_schema: {
      type: 'object',
      properties: {
        zip: { type: 'string', description: '5-digit Florida ZIP, e.g. "32601"' },
        county: { type: 'string', description: 'Florida county name, e.g. "Alachua", "Palm Beach", "Orange"' },
        year: { type: 'number', description: 'Plan year, default 2027 (AEP)' },
        planType: { type: 'string', description: 'Optional plan type filter, e.g. "MAPD", "MA", "SNP"' },
        referenceSummary: { type: 'string', description: 'Short text of the client\'s current plan benefits for similarity matching against returned candidates only' }
      },
      required: ['zip']
    }
  },
  {
    name: 'search_drug',
    description: 'Sunfire drug catalog only (name / NDC / drug id). Does NOT return a plan formulary tier. Daisy / paste "Tier X" is discarded. For tier / PA / ST / coverage on a named plan, call lookup_formulary (or pass planId/planIds here).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drug name or partial name, e.g. "metformin", "trintellix"' },
        ndc: { type: 'string', description: 'Optional NDC if the agent has it' },
        planId: { type: 'string', description: 'Optional CMS contract-PBP. If set, also runs lookup_formulary for that plan.' },
        planIds: { type: 'array', items: { type: 'string' }, description: 'Optional list of CMS IDs to formulary-check in the same call' },
        year: { type: 'number', description: 'Plan year. Default 2027.' },
        claimedTier: { type: 'number', description: 'Discarded. Daisy / paste tier labels are never stored or quoted.' }
      },
      required: ['name']
    }
  },
  {
    name: 'lookup_formulary',
    description: 'REQUIRED before quoting a drug tier, PA/ST, or T4 % cost. Looks up each drug × plan contract-PBP for the plan year (default 2027): Sunfire when SUNFIRE_JWT works, then Humana FHIR only if PlanID+year match this PBP, then medicare.gov Plan Compare, then carrier consumer documents (Doctors 2027 formulary PDF for H4140; 001→022, 012→023). Attaches T1–T6 cost-share from THEI 2027 Hub/grid knowledge. Daisy / paste "Tier X" is discarded — never quote or imply it. If lookup fails, return unverified. When a brand is verified not covered, automatically looks up the known generic (Lipitor→Atorvastatin, Benicar→Olmesartan) — do not wait for the agent to type the generic. Brand shows not covered with the asterisk note; generic tier comes from that live follow-up only — never invent a tier. Call once per drug (pass all named planIds).',
    input_schema: {
      type: 'object',
      properties: {
        drugName: { type: 'string', description: 'Drug name, e.g. "Trintellix" or "Atorvastatin"' },
        ndc: { type: 'string', description: 'Optional NDC' },
        planId: { type: 'string', description: 'CMS contract-PBP, e.g. "H1036-054C"' },
        planIds: { type: 'array', items: { type: 'string' }, description: 'Multiple CMS IDs, e.g. ["H1036-054C","H1036-305"]' },
        year: { type: 'number', description: 'Plan year, default 2027' },
        claimedTier: { type: 'number', description: 'Discarded. Never quoted or used.' }
      },
      required: ['drugName']
    }
  },
  {
    name: 'lookup_sob_benefit',
    description: 'REQUIRED when an asked benefit is not on the 2027 THEI Plan Comparison Grid green cells. Reads that plan\'s Summary of Benefits (sobUrl already on the plan object) and extracts the asked line (hearing aids copay, SNF days 1–20 and 21–100, hospital-grade bed / DME, or a free-text query). Grid green cells first. Then SOB. Never invent a dollar amount. If the SOB cannot be read, return unverified — never fill from 2026 or memory. Pass planId/planIds plus sobUrl or the plan objects from PLAN DATA. Call once per comparison (all named planIds).',
    input_schema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'CMS contract-PBP, e.g. H1036-054C' },
        planIds: { type: 'array', items: { type: 'string' }, description: 'All compared CMS IDs' },
        sobUrl: { type: 'string', description: 'Official SOB PDF URL when looking up a single plan' },
        plans: {
          type: 'array',
          items: { type: 'object' },
          description: 'Plan objects from PLAN DATA (planId, sobUrl, hearing, …)',
        },
        benefits: {
          type: 'array',
          items: { type: 'string' },
          description: 'hearing_aids, skilled_nursing, dme / hospital_bed',
        },
        query: { type: 'string', description: 'Free-text need, e.g. hospital-grade bed, SNF days 21-100' },
        year: { type: 'number', description: 'Plan year, default 2027' },
      },
    },
  }
];

// Process tool calls (async to support live lookups)
async function processTool(toolName, toolInput) {
  if (toolName === 'search_knowledge') {
    const results = searchKnowledge(toolInput.query);
    if (!results.length) return 'No results found for that query.';
    return results.map(r => `### ${r.key}\n${r.content.slice(0, 8000)}`).join('\n\n---\n\n');
  }
  if (toolName === 'fetch_web_page') {
    return fetchUrl(toolInput.url);
  }
  if (toolName === 'get_knowledge_doc') {
    const doc = getKnowledgeByKey(toolInput.key);
    return doc || `Document "${toolInput.key}" not found.`;
  }
  if (toolName === 'search_clinic_or_provider') {
    try {
      const npiHint = toolInput.npi ? String(toolInput.npi) : '';
      return await searchClinicOrProvider({
        name: [toolInput.name || toolInput.clinicName || '', npiHint].filter(Boolean).join(' '),
        state: toolInput.state || 'FL',
        zip: toolInput.zip,
        city: toolInput.city,
        siteUrl: toolInput.siteUrl || toolInput.url,
        askedCarrier: toolInput.askedCarrier || toolInput.carrier,
      });
    } catch (e) {
      return `Clinic search error: ${e.message}`;
    }
  }
  if (toolName === 'lookup_provider_network') {
    try {
      const doctorName = toolInput.doctorName || '';
      const zip = toolInput.zip || '33136';
      const planYear = toolInput.year || Number(UHC_PLAN_YEAR);
      const guestPlanIds = toolInput.planId ? [String(toolInput.planId)] : [];
      const results = await resolveNpiRecords({
        doctorName,
        zip,
        state: toolInput.state || 'FL',
        npi: toolInput.npi,
        limit: 5,
      });
      if (!results.length) {
        return `No providers found matching "${doctorName}" in Florida (NPI-1 person or NPI-2 clinic). If this is a clinic/group/DBA, call search_clinic_or_provider, then re-run lookup_provider_network with the NPI. Do not invent In/Out from a clinic insurances-accepted webpage.`;
      }
      // Step 2: FHIR + Doctors directory for each NPI
      const CARRIERS = [
        { name: 'Florida Blue', key: 'flblue', base: 'https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir' },
        { name: 'Cigna', key: 'cigna', base: 'https://fhir.cigna.com/ProviderDirectory/v1' },
        { name: 'HealthSun', key: 'healthsun', base: 'https://api.aaneelconnect.com/cms/r4/providerdirectory', extra: 'payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95' },
        { name: 'Devoted Health', key: 'devoted', base: 'https://fhir.devoted.com/fhir' },
      ];
      const providerResults = [];
      for (const p of results.slice(0, 5)) {
        const npi = p.number;
        const pName = displayName(p) || [p.basic?.first_name, p.basic?.middle_name, p.basic?.last_name].filter(Boolean).join(' ');
        const spec = (p.taxonomies || []).find(t => t.primary)?.desc || 'Unknown';
        const locs = allLocationAddresses(p);
        const addr = locs[0] || {};
        const address = locs.length
          ? locs.map((a) => `${a.address_1 || ''}, ${a.city || ''}, FL ${String(a.postal_code || '').slice(0, 5)}`.trim()).join(' | ')
          : `${addr.address_1 || ''}, ${addr.city || ''}, FL ${addr.postal_code || ''}`.trim();
        const inNetworkFor = [];
        const fhirLookups = CARRIERS.map(async (carrier) => {
          try {
            const url = carrier.extra
              ? `${carrier.base}/PractitionerRole?practitioner.identifier=${npi}&${carrier.extra}`
              : `${carrier.base}/PractitionerRole?practitioner.identifier=${npi}`;
            const r = await fetch(url, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(8000) });
            if (r.ok) {
              const fd = await r.json();
              if ((fd.total || 0) > 0 || (fd.entry || []).length > 0) {
                inNetworkFor.push(carrier.name);
              }
            }
          } catch(e) { /* skip carrier */ }
        });
        const [doctorsResult, aetnaResult, simplyResult, uhcResult, humanaResult] = await Promise.all([
          queryDoctorsHcp(npi),
          queryAetnaPublic(npi, { zip, lastName: p.basic?.last_name || p.basic?.organization_name || '' }),
          querySimplyFindcare(npi, { zip, lastName: p.basic?.last_name || p.basic?.organization_name || '' }),
          queryUhcGuest(npi, { zip, year: planYear, planIds: guestPlanIds }),
          queryHumanaFindcare(npi, { zip, year: planYear, planIds: guestPlanIds }),
          Promise.all(fhirLookups),
        ]);
        if (doctorsResult.inNetwork && !inNetworkFor.includes(DOCTORS_PLAN_LABEL)) {
          inNetworkFor.push(DOCTORS_PLAN_LABEL);
        }
        if (!aetnaResult.error && aetnaResult.inNetwork) {
          for (const plan of aetnaResult.plans) {
            if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
          }
          if (!aetnaResult.plans.length && !inNetworkFor.includes(AETNA_PLAN_LABEL)) {
            inNetworkFor.push(AETNA_PLAN_LABEL);
          }
        }
        if (!simplyResult.error && simplyResult.inNetwork) {
          for (const plan of simplyResult.plans) {
            if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
          }
          if (!simplyResult.plans.length && !inNetworkFor.includes(SIMPLY_PLAN_LABEL)) {
            inNetworkFor.push(SIMPLY_PLAN_LABEL);
          }
        }
        if (!uhcResult.error && uhcResult.inNetwork) {
          for (const plan of uhcResult.plans) {
            if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
          }
        }
        if (!humanaResult.error && humanaResult.inNetwork) {
          for (const plan of humanaResult.plans) {
            if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
          }
        }
        const lookupErrors = [];
        if (doctorsResult.error) lookupErrors.push('Doctors HealthCare Plans');
        if (aetnaResult.error) lookupErrors.push('Aetna guest search');
        if (simplyResult.error) lookupErrors.push('Simply Find Care');
        if (uhcResult.error) lookupErrors.push('UHC guest Find a Doctor');
        if (humanaResult.error) lookupErrors.push('Humana Find Care');
        const checkedGuest = ['FL Blue', 'Cigna', 'HealthSun', 'Devoted', 'Doctors'];
        if (!aetnaResult.error) checkedGuest.push('Aetna guest search');
        if (!simplyResult.error) checkedGuest.push('Simply Find Care');
        checkedGuest.push('UHC guest Find a Doctor');
        checkedGuest.push('Humana Find Care');
        providerResults.push({
          name: pName,
          npi,
          specialty: spec,
          address,
          inNetworkFor,
          lookupErrors,
          checkedGuest,
          uhcResult,
          humanaResult,
        });
      }
      if (!providerResults.length) return `Found NPIs but no network data available.`;
      // Step 3: Sunfire /v2/provider/list for WellCare, CarePlus, etc. (Humana only if Find Care failed)
      const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
      const SUNFIRE_JWT = process.env.SUNFIRE_JWT || '';
      const SUNFIRE_SFP = process.env.SUNFIRE_SFP || '';
      const humanaGuestOk = providerResults.some((pr) => (
        pr.humanaResult?.checks?.some((c) => c.status === 'in_network' || c.status === 'out_of_network')
      ));
      const sunfireInNetwork = []; // resolved plan name strings
      if (SUNFIRE_JWT && SUNFIRE_SFP && providerResults.length > 0) {
        try {
          const sfProviders = providerResults.map(pr => ({
            id: pr.npi, name: pr.name, firstName: pr.name.split(' ')[0], radius: 25, primaryDoctor: true
          }));
          const sfRes = await fetch(`${SUNFIRE_BASE}/v2/provider/list`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${SUNFIRE_JWT}`,  // unified Bearer format
              'Content-Type': 'application/json',
              'Cookie': `sfp-cookie=${SUNFIRE_SFP}`,
              'Origin': SUNFIRE_BASE,
              'Referer': `${SUNFIRE_BASE}/app/agent/yourmedicare/`
            },
            body: JSON.stringify({
              type: 'network', county: '12086', year: planYear, zip,
              providers: sfProviders, restrictedProviderCarrierId: ''
            }),
            signal: AbortSignal.timeout(15000)
          });
          if (sfRes.ok) {
            const sfData = await sfRes.json();
            const sfPlans = sfData.plans || [];
            for (const plan of sfPlans) {
              const docs = plan.doctorInformation || [];
              const covered = docs.some(doc =>
                doc.covered === 'Y' && (doc.locations || []).some(l => l.covered === 'Y')
              );
              if (!covered) continue;
              const id = String(plan.id);
              const mapEntry = SUNFIRE_PLAN_MAP[id];
              let label;
              if (mapEntry) {
                label = mapEntry.planName
                  ? `${mapEntry.planName} (${mapEntry.carrier})`
                  : (mapEntry.carrier || `Plan ${id}`);
              } else {
                label = `Plan ID ${id}`;
              }
              if (humanaGuestOk && isHumanaLabel(label)) continue;
              if (!sunfireInNetwork.includes(label)) sunfireInNetwork.push(label);
            }
          }
        } catch(e) { console.log('[Sunfire lookup error]', e.message); }
      }

      let out = `Provider network results for "${doctorName}":\n\n`;
      for (const pr of providerResults) {
        out += `**${pr.name}** (NPI: ${pr.npi})\n`;
        out += `Specialty: ${pr.specialty}\n`;
        out += `Address: ${pr.address}\n`;
        const allNetworks = [...pr.inNetworkFor];
        const missList = (pr.checkedGuest || ['FL Blue', 'Cigna', 'HealthSun', 'Devoted', 'Doctors', 'Aetna guest search', 'Simply Find Care', 'UHC guest Find a Doctor', 'Humana Find Care']).join(', ');
        out += allNetworks.length ? `In-network for: ${allNetworks.join(', ')}\n` : `Not found in ${missList} (a miss on FHIR/Doctors/Aetna/Simply is not a UHC or Humana answer).\n`;
        if (pr.uhcResult) out += `${formatUhcAgentNote(pr.uhcResult)}\n`;
        if (pr.humanaResult) out += `${formatHumanaAgentNote(pr.humanaResult)}\n`;
        if (sunfireInNetwork.length > 0) {
          out += `Sunfire also listed (${sunfireInNetwork.length}; secondary, year ${planYear}):\n${sunfireInNetwork.map(p => `  - ${p}`).join('\n')}\n`;
        } else {
          out += SUNFIRE_SFP
            ? `Sunfire did not confirm additional plans for ${planYear}. Empty Sunfire is not UHC or Humana out-of-network.\n`
            : `Sunfire session unavailable (secondary only). UHC uses public guest Find a Doctor. Humana uses public Find Care. Wellcare / CarePlus still need Sunfire or the carrier site.\n`;
        }
        if (pr.lookupErrors?.length) {
          out += `Could not complete: ${pr.lookupErrors.join(', ')} — that is not the same as out-of-network. Hand the agent the guest URL.\n`;
        }
        out += `${formatSolisNote(zip)}\n`;
        out += '\n';
      }
      out += 'Note: Cigna/HealthSpring directory hits are not a 2027 Miami-Dade or Broward MA enrollment option. HealthSpring has no 2027 MA plans in those counties.\n';
      // Build structured output for frontend (v11 toolResults schema)
      const firstProvider = providerResults[0];
      const structured = firstProvider ? {
        doctorName: firstProvider.name,
        npi: firstProvider.npi,
        networks: [
          ...CARRIERS.map(c => ({
            carrier: c.name,
            inNetwork: firstProvider.inNetworkFor.includes(c.name)
          })),
          {
            carrier: DOCTORS_PLAN_LABEL,
            inNetwork: firstProvider.inNetworkFor.includes(DOCTORS_PLAN_LABEL)
          },
          {
            carrier: AETNA_PLAN_LABEL,
            inNetwork: firstProvider.inNetworkFor.some(p => /aetna/i.test(p))
          },
          {
            carrier: SIMPLY_PLAN_LABEL,
            inNetwork: firstProvider.inNetworkFor.some(p => /simply/i.test(p))
          },
          {
            carrier: UHC_PLAN_LABEL,
            inNetwork: Boolean(firstProvider.uhcResult?.inNetwork),
            status: firstProvider.uhcResult?.error
              ? 'failed'
              : (firstProvider.uhcResult?.inNetwork ? 'in_network' : 'checked'),
            plans: firstProvider.uhcResult?.plans || [],
            outOfNetworkPlans: firstProvider.uhcResult?.outOfNetworkPlans || [],
            year: firstProvider.uhcResult?.year || UHC_PLAN_YEAR,
          },
          {
            carrier: HUMANA_PLAN_LABEL,
            inNetwork: Boolean(firstProvider.humanaResult?.inNetwork),
            status: firstProvider.humanaResult?.error
              ? 'failed'
              : (firstProvider.humanaResult?.inNetwork ? 'in_network' : 'checked'),
            plans: firstProvider.humanaResult?.plans || [],
            outOfNetworkPlans: firstProvider.humanaResult?.outOfNetworkPlans || [],
            year: firstProvider.humanaResult?.year || UHC_PLAN_YEAR,
          }
        ]
      } : { doctorName, networks: [] };
      return { text: out.slice(0, 7000), structured };
    } catch (e) { return `Provider lookup error: ${e.message}`; }
  }
  if (toolName === 'discover_similar_plans') {
    try {
      const result = await discoverPlansForArea({
        zip: toolInput.zip,
        county: toolInput.county,
        year: toolInput.year || Number(UHC_PLAN_YEAR),
        planType: toolInput.planType,
        referenceSummary: toolInput.referenceSummary,
      });
      const lines = [];
      lines.push(`Plan discovery for ZIP ${result.zip}` + (result.county ? ` (${result.county})` : '') + `, year ${result.year}:`);
      lines.push(`Source: ${result.source || 'none'}`);
      lines.push(`Plan Compare (enter ZIP ${result.zip} manually): ${result.planCompareUrl}`);
      if (result.countyFips) lines.push(`County FIPS: ${result.countyFips}`);
      if (result.plans && result.plans.length) {
        lines.push(`Candidates (${result.plans.length}, not ranked — TPMO: do not pick a "best"):`);
        for (const pl of result.plans) {
          const idPart = pl.planId ? ` [${pl.planId}]` : '';
          const sfPart = pl.sunfireId ? ` (Sunfire ${pl.sunfireId})` : '';
          lines.push(`  - ${pl.carrier}: ${pl.planName}${idPart}${sfPart}`);
        }
      } else {
        lines.push('No Sunfire candidates returned. Use Sunfire broker portal and/or Plan Compare.');
      }
      if (result.note) lines.push(`Note: ${result.note}`);
      if (result.errors && result.errors.length) lines.push(`Errors: ${result.errors.join('; ')}`);
      if (result.referenceSummary) lines.push(`referenceSummary (echo): ${result.referenceSummary}`);
      lines.push('THEI benefit grid does not cover this county. Do not invent premiums/MOOP/dental from memory. Agent verifies in Sunfire/SOB/Plan Compare.');
      return { text: lines.join('\n').slice(0, 8000), structured: result };
    } catch (e) {
      return `Plan discovery error: ${e.message}`;
    }
  }
  if (toolName === 'search_drug' || toolName === 'lookup_formulary') {
    try {
      const drugName = toolInput.drugName || toolInput.name || '';
      const planIds = []
        .concat(toolInput.planId || [])
        .concat(toolInput.planIds || [])
        .filter(Boolean);
      const wantsFormulary = toolName === 'lookup_formulary' || planIds.length > 0;
      if (!wantsFormulary) {
        const result = await lookupFormulary({
          drugName,
          ndc: toolInput.ndc,
          year: toolInput.year || 2027,
        });
        const catalog = (result.catalog || []).slice(0, 10);
        if (!catalog.length) {
          const err = result.catalogError ? ` (${result.catalogError})` : '';
          return `No drugs found matching "${drugName}"${err}. Catalog only — call lookup_formulary with a plan ID before quoting a tier.`;
        }
        return (
          `Found ${catalog.length} catalog match(es) for "${drugName}" (name/NDC only — tiers NOT verified):\n` +
          catalog.map((d) => `- ${d.name}${d.ndc ? ` (NDC: ${d.ndc})` : ''}`).join('\n') +
          `\nCatalog only — call lookup_formulary with drugName + planIds before quoting a tier.`
        );
      }
      const result = await lookupFormulary({
        drugName,
        ndc: toolInput.ndc,
        planId: toolInput.planId,
        planIds: toolInput.planIds,
        year: toolInput.year || 2027,
      });
      return {
        text: formatFormularyText(result),
        structured: { ...result, drug: toExportDrug(result), drugs: toExportDrugs(result) },
      };
    } catch (e) {
      return `Formulary lookup error: ${e.message}. Do not quote a tier.`;
    }
  }
  if (toolName === 'lookup_sob_benefit') {
    try {
      const result = await lookupSobBenefits({
        planId: toolInput.planId,
        planIds: toolInput.planIds,
        sobUrl: toolInput.sobUrl,
        plans: toolInput.plans,
        benefits: toolInput.benefits,
        query: toolInput.query,
        year: toolInput.year || 2027,
      });
      return {
        text: formatSobLookupText(result),
        structured: { ...result, sobBenefits: toExportSobBenefits(result) },
      };
    } catch (e) {
      return `SOB lookup error: ${e.message}. Do not invent a dollar amount.`;
    }
  }
  return 'Unknown tool.';
}

async function chat(messages) {
  // LEGACY MODE — delegates to Grok. Pass-through is handled in server.js.
  loadKnowledge();
  const { chat: grokChat } = require('./grok');
  return grokChat(messages, SYSTEM_PROMPT);
}

module.exports = { chat, TOOLS, processTool, SYSTEM_PROMPT };
