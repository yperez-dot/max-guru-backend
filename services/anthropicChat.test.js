const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildAnthropicBody, toAnthropicMessages, fromAnthropicResponse } = require('./anthropicChat');

describe('OpenAI-shaped chat → Claude Messages API', () => {
  it('maps text, images, assistant tool_calls and tool results; merges same-role turns', () => {
    const msgs = toAnthropicMessages([
      { role: 'system', content: 'ignored here (sent as system)' },
      { role: 'user', content: [{ type: 'text', text: 'Is Dr. Morytko in Devoted?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup_provider_network', arguments: '{"doctorName":"John Morytko"}' } }, { id: 't2', type: 'function', function: { name: 'lookup_formulary', arguments: '{bad json' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'Devoted: In' },
      { role: 'tool', tool_call_id: 't2', content: '' },
      { role: 'user', content: 'thanks' },
    ]);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    assert.deepEqual(msgs[1].content.map((b) => b.type), ['tool_use', 'tool_use']);
    assert.deepEqual(msgs[1].content[0].input, { doctorName: 'John Morytko' });
    assert.deepEqual(msgs[1].content[1].input, {});
    assert.equal(msgs[2].role, 'user');
    assert.deepEqual(msgs[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
    assert.equal(msgs[2].content[1].content, '(empty)');
  });

  it('caches the system prompt and the latest turn; converts tools', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-5-5',
      system: 'GRID',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'search_drug', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
    });
    assert.deepEqual(body.system, [{ type: 'text', text: 'GRID', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(body.tools[0], { name: 'search_drug', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } });
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  });

  it('maps the reply back: tool_use → tool_calls, usage incl. cache reads', () => {
    const r = fromAnthropicResponse({
      id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_1', name: 'lookup_provider_network', input: { doctorName: 'X' } }],
      usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 },
    });
    assert.equal(r.choices[0].finish_reason, 'tool_calls');
    assert.equal(r.choices[0].message.content, 'Checking.');
    assert.deepEqual(r.choices[0].message.tool_calls[0], { id: 'tu_1', type: 'function', function: { name: 'lookup_provider_network', arguments: '{"doctorName":"X"}' } });
    assert.equal(r.usage.prompt_tokens, 9100);
    assert.equal(r.usage.prompt_tokens_details.cached_tokens, 9000);
    assert.equal(r.usage.completion_tokens, 50);
  });
});

describe('Max chat loop on LLM_PROVIDER=claude', () => {
  const saved = { fetch: global.fetch, env: { ...process.env } };
  afterEach(() => {
    global.fetch = saved.fetch;
    process.env = { ...saved.env };
    delete require.cache[require.resolve('./grok')];
  });

  it('calls /v1/messages with x-api-key, runs the tool, returns the final text', async () => {
    process.env.LLM_PROVIDER = 'claude';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
    delete process.env.CLAUDE_MODEL;
    delete require.cache[require.resolve('./grok')];
    const { passThroughChat, providerConfig } = require('./grok');
    assert.equal(providerConfig().model, 'claude-sonnet-5-5');

    const calls = [];
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, headers: opts.headers, body });
      const reply = calls.length === 1
        ? { id: 'm1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'search_drug', input: { query: 'eliquis' } }], usage: { input_tokens: 10, output_tokens: 5 } }
        : { id: 'm2', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Eliquis is apixaban.' }], usage: { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 8 } };
      return { ok: true, status: 200, json: async () => reply };
    };
    const ran = [];
    const out = await passThroughChat({
      system: 'You are Max.',
      messages: [{ role: 'user', content: 'What is Eliquis?' }],
      processToolFn: async (name, input) => { ran.push([name, input]); return 'apixaban'; },
      deadlineMs: 30000,
    });
    assert.match(calls[0].url, /api\.anthropic\.com\/v1\/messages$/);
    assert.equal(calls[0].headers['x-api-key'], 'sk-test');
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(calls[0].headers['anthropic-workspace-id'], 'wrkspc_test');
    assert.deepEqual(ran, [['search_drug', { query: 'eliquis' }]]);
    const second = calls[1].body.messages;
    assert.equal(second[second.length - 1].content[0].type, 'tool_result');
    assert.equal(second[second.length - 1].content[0].tool_use_id, 'tu_1');
    const text = (out.content || []).map((b) => b.text).join('');
    assert.match(text, /apixaban/);
  });
});
