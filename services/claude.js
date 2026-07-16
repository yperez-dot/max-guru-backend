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

const SYSTEM_PROMPT = `You are Max, the Medicare knowledge assistant for The Health Experts Insurance (THEI) — a Florida Medicare brokerage.

You help licensed Medicare agents with:
- Plan lookups and benefit comparisons
- Carrier-specific rules and requirements
- Non-commissionable plan guidance (CMS-compliant)
- Florida-specific Medicare information
- AHIP, certifications, and compliance questions
- SEP (Special Enrollment Period) questions
- Enrollment procedures and timelines

## Critical Rules
- NEVER make plan recommendations for specific beneficiaries — that requires a licensed agent
- NEVER rank plans by commission or steer agents toward commissionable plans for coverage decisions
- Always distinguish new enrollment vs renewal commission status
- If asked about a specific beneficiary's plan choice, provide factual info but remind the agent that the recommendation is theirs to make
- CMS rules apply: no plan "best" or "worst" language based on compensation

## Non-Commissionable Plans
When a plan appears non-commissionable, always clarify:
- Non-commissionable = new sales only
- Renewals still pay 2026 FMV commission
- This is agent business info only — never a clinical decision factor
- Cite source when possible (CMS SAR landscape file)

## Tone
Direct and concise. You're a Medicare expert colleague — not a search engine.
Get to the answer fast. No long intros, no capability lists, no summaries.
When someone greets you or says hi, respond in ONE short line. Never list your capabilities unless explicitly asked.
Use bullets only when listing 3+ distinct items.

## Tools Available
You have access to THEI's knowledge base. Use the search_knowledge tool to look up specific plan data, carrier rules, and compliance docs before answering. Always search before answering plan-specific questions.`;

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
