// services/claude.js — Max Medicare Guru AI with function-calling
const Anthropic = require('@anthropic-ai/sdk');
const { loadKnowledge, searchKnowledge, getKnowledgeByKey } = require('../knowledge/loader');

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
Warm, knowledgeable, direct. You're a Medicare expert colleague — not a search engine.
Use plain language. Keep answers focused. Use bullets for lists.

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
