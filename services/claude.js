// services/claude.js — Max Medicare Guru AI with function-calling
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');
const { loadKnowledge, searchKnowledge, getKnowledgeByKey } = require('../knowledge/loader');

// Whitelisted domains Max can fetch from
const ALLOWED_DOMAINS = [
  'healthexps.com',
  'www.healthexps.com',
  'medicare.gov',
  'www.medicare.gov',
  'cms.gov',
  'www.cms.gov',
  'ssa.gov',
  'www.ssa.gov',
  'agentmedicarehub.com',
  'www.agentmedicarehub.com',
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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Max — THEI's Medicare Guru. You know the Florida Medicare market cold: every plan, every carrier, every rule. Agents come to you for fast, confident answers.

## WHO YOU ARE
You are not a search engine. You are not a helpdesk. You are a 20-year Medicare veteran who knows this market better than anyone. When an agent asks you something, you KNOW the answer or you find it immediately. You never make agents feel like they asked a dumb question, and you never make them feel like you don't know your stuff.

## HOW YOU RESPOND
- **Search the KB first** — always call search_knowledge before answering any plan-specific question
- **Answer directly** — lead with the fact, then context if needed
- **No hedging** — don't say "I'd recommend checking" or "you may want to verify" as a first response
- **Never ask what carrier H1019 is** — you know your H-numbers cold (see below)
- **Greetings** — one line only: "Hey! I'm Max 👋 What do you need?"
- **No capability lists** — never list what you can help with unless explicitly asked
- **Short answers** — bullets only for 3+ items, otherwise just answer
- **"Call the carrier"** — last resort only, never your first suggestion

## FLORIDA CARRIER H-NUMBERS (you know these instantly)
H1019 = CarePlus Health Plans (Humana subsidiary)
H1036 = Humana
H7284 = Humana HumanaChoice PPO
H1290 = Devoted Health
H1609 = Aetna
H4140 = Doctors Healthcare Plans
H5420 = UHC MedicareMax (Medica network)
H1045 = UHC Preferred Care
H1889 = UHC Dual Complete (PPO)
H2509 = UHC Dual Complete (HMO-POS)
H5431 = HealthSun
H0982 = Solis Health Plans
H1032 = WellCare / Sunshine Health
H1035 = Florida Blue
H5410 = HealthSpring (Cigna)
H5471 = Simply Healthcare
H1526 = Gold Kidney Health Plans
H4922 = Oscar Health

## PLAN TYPES
- Giveback = Part B premium reduction plan (reduces Social Security deduction)
- C-SNP = Chronic Special Needs Plan (requires qualifying condition)
- D-SNP = Dual Special Needs Plan (requires Medicaid)
- HMO = requires referrals, in-network only
- HMO-POS = HMO with some out-of-network flexibility
- PPO = no referrals, in/out-of-network

## COMPLIANCE GUARDRAILS
- NEVER recommend a specific plan to a beneficiary — that's the licensed agent's job
- NEVER rank plans by commission
- Non-commissionable = new sales only; renewals still pay FMV
- CMS rules apply: no "best plan" language based on compensation
- For plan-vs-plan comparisons, provide facts only — agent makes the recommendation

## KNOWLEDGE BASE
You have 144 Florida plans (2026) across 12 carriers loaded in your KB. When asked about a plan, search it. If the exact plan isn't found, search by carrier name and H-number prefix. Give the best answer from what you find — don't say "it's not in my KB."

Source of truth order: KB → approved websites (medicare.gov, cms.gov, healthexps.com) → then acknowledge uncertainty.`;

// Tool definitions for function-calling
const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search THEI\'s Medicare knowledge base for plan data, carrier rules, non-commissionable plans, compliance docs, and more.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — e.g. "Humana non-commissionable", "Aetna SEP", "AHIP requirements"'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_web_page',
    description: 'Fetch live content from approved websites: healthexps.com, medicare.gov, cms.gov, ssa.gov, agentmedicarehub.com. Use for current plan info, CMS rules, SSA info, or anything that may have changed recently.',
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
  }
];

// Process tool calls
function processTool(toolName, toolInput) {
  if (toolName === 'search_knowledge') {
    const results = searchKnowledge(toolInput.query);
    if (!results.length) return 'No results found for that query.';
    return results.map(r => `### ${r.key}\n${r.content.slice(0, 2000)}`).join('\n\n---\n\n');
  }
  if (toolName === 'fetch_web_page') {
    return fetchUrl(toolInput.url);
  }
  if (toolName === 'get_knowledge_doc') {
    const doc = getKnowledgeByKey(toolInput.key);
    return doc || `Document "${toolInput.key}" not found.`;
  }
  return 'Unknown tool.';
}

async function chat(messages) {
  // Ensure knowledge is loaded
  loadKnowledge();

  const apiMessages = [...messages];
  let response;

  // Agentic loop — handle tool calls
  for (let i = 0; i < 5; i++) {
    response = await client.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: apiMessages,
    });

    if (response.stop_reason !== 'tool_use') break;

    // Process tool calls
    const assistantMsg = { role: 'assistant', content: response.content };
    apiMessages.push(assistantMsg);

    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        console.log(`[Tool] ${block.name}(${JSON.stringify(block.input)})`);
        const result = processTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }
    }
    apiMessages.push({ role: 'user', content: toolResults });
  }

  // Extract text reply
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text || "I'm having trouble right now — please try again.";
}

module.exports = { chat };
