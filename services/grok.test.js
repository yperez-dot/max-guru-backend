const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const prev = {
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  XAI_API_KEY: process.env.XAI_API_KEY,
  GROK_MODEL: process.env.GROK_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

function loadGrok(env) {
  process.env.LLM_PROVIDER = env.provider;
  if (env.provider === 'openai') {
    process.env.OPENAI_API_KEY = env.key;
  } else {
    process.env.XAI_API_KEY = env.key;
    process.env.GROK_MODEL = env.model || 'grok-4.6';
  }
  delete require.cache[require.resolve('./grok')];
  delete require.cache[require.resolve('./chatImages')];
  return require('./grok');
}

async function withMockedFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    return handler(url, body);
  };
  try {
    return await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function visionReply() {
  return {
    ok: true,
    json: async () => ({
      id: 'chatcmpl-vision',
      model: 'grok-4.6',
      choices: [{ message: { role: 'assistant', content: 'This SoB is Humana Gold Plus H1036-054.' } }],
      usage: { prompt_tokens: 1800, completion_tokens: 24 },
    }),
  };
}

describe('multimodal forwarding to Grok / OpenAI', () => {
  after(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('./grok')];
  });

  it('forwards text + image_url parts on the default Grok path', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    await withMockedFetch(() => visionReply(), async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What plan is this?' },
              { type: 'image_url', image_url: { url: TINY_PNG } },
            ],
          },
        ],
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /api\.x\.ai\/v1\/chat\/completions/);
      const user = calls[0].body.messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(user.content));
      assert.deepEqual(user.content[0], { type: 'text', text: 'What plan is this?' });
      assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: TINY_PNG } });
      assert.equal(calls[0].body.messages.some((m) => m.role === 'system'), true);
      assert.equal(result.content[0].text.includes('Humana Gold Plus'), true);
      assert.equal(result.provider, 'grok');
      assert.ok(Array.isArray(result.usageCalls));
      assert.equal(result.usageCalls[0].usage.prompt_tokens, 1800);
    });
  });

  it('keeps the same vision parts when LLM_PROVIDER=openai', async () => {
    const { passThroughChat } = loadGrok({ provider: 'openai', key: 'test-openai-key' });
    await withMockedFetch(() => ({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-oai',
        model: 'gpt-4.1',
        choices: [{ message: { role: 'assistant', content: 'I see a Humana SoB.' } }],
        usage: { prompt_tokens: 900, completion_tokens: 12 },
      }),
    }), async (calls) => {
      await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this screenshot.' },
              { type: 'image_url', image_url: { url: TINY_PNG } },
            ],
          },
        ],
      });
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /api\.openai\.com\/v1\/chat\/completions/);
      const user = calls[0].body.messages.find((m) => m.role === 'user');
      assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: TINY_PNG } });
    });
  });
});

describe('auto SOB lookup on comparison chat', () => {
  after(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('./grok')];
  });

  it('looks up SNF and DME when she asked and the model skipped the tool', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    const stubCalls = [];
    const stub = async (name, input) => {
      stubCalls.push({ name, input });
      assert.equal(name, 'lookup_sob_benefit');
      return {
        text: 'SOB_LOOKUP H1036-054C snfDays1to20: Days 1-20: $0 copay',
        structured: {
          sobBenefits: {
            'H1036-054C': { snfDays1to20: { value: 'Days 1-20: $0 copay', source: 'sob' } },
          },
        },
      };
    };
    await withMockedFetch((url, body) => {
      const last = body.messages[body.messages.length - 1];
      const asked = typeof last.content === 'string' && /Required SOB lookup/.test(last.content);
      return {
        ok: true,
        json: async () => ({
          id: asked ? 'chatcmpl-sob2' : 'chatcmpl-sob1',
          model: 'grok-4.6',
          choices: [
            {
              message: {
                role: 'assistant',
                content: asked
                  ? 'H1036-054C SNF days 1-20: $0 copay. Others Unverified.'
                  : 'Comparing Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, and UHC MedicareMax FL-0028 H5420-001.',
              },
            },
          ],
        }),
      };
    }, async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content:
              'Compare H1036-054C, H4140-023, and H5420-001 for Mr. and Mrs. Muskat. Need SNF days 1-20, SNF days 21-100, and hospital-grade bed / DME.',
          },
        ],
        processToolFn: stub,
      });
      assert.equal(calls.length, 2);
      assert.equal(stubCalls.length, 1);
      assert.deepEqual(stubCalls[0].input.benefits, ['skilled_nursing', 'dme']);
      assert.ok(stubCalls[0].input.planIds.includes('H1036-054C'));
      assert.ok(stubCalls[0].input.planIds.includes('H4140-023'));
      assert.ok(stubCalls[0].input.planIds.includes('H5420-001'));
      assert.ok((result.toolResults || []).some((t) => t.tool === 'lookup_sob_benefit'));
      assert.match(result.content[0].text, /\$0 copay/);
    });
  });

  it('looks up an asked off-grid benefit that is not SNF or DME', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    const stubCalls = [];
    const stub = async (name, input) => {
      stubCalls.push({ name, input });
      return {
        text: 'SOB_LOOKUP H1036-054C chemotherapy: Chemotherapy $35 copay (source sob)',
        structured: {
          sobBenefits: {
            'H1036-054C': { chemotherapy: { value: 'Chemotherapy $35 copay', source: 'sob' } },
          },
        },
      };
    };
    await withMockedFetch((url, body) => {
      const last = body.messages[body.messages.length - 1];
      const asked = typeof last.content === 'string' && /Required SOB lookup/.test(last.content);
      return {
        ok: true,
        json: async () => ({
          id: asked ? 'chatcmpl-chemo2' : 'chatcmpl-chemo1',
          model: 'grok-4.6',
          choices: [
            {
              message: {
                role: 'assistant',
                content: asked
                  ? 'H1036-054C chemotherapy: $35 copay.'
                  : 'H1036-054C chemotherapy is not on the grid.',
              },
            },
          ],
        }),
      };
    }, async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content: 'What is the copay for chemotherapy on H1036-054C?',
          },
        ],
        processToolFn: stub,
      });
      assert.equal(calls.length, 2);
      assert.equal(stubCalls.length, 1);
      assert.deepEqual(stubCalls[0].input.benefits, ['chemotherapy']);
      assert.match(result.content[0].text, /\$35 copay/);
    });
  });

  it('does not auto-lookup a comparison when she did not ask for SNF or DME', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    let stubbed = 0;
    await withMockedFetch(() => ({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-cmp',
        model: 'grok-4.6',
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                'Comparing Humana Gold Plus H1036-054C, Doctors DrSelect-SFL H4140-023, and UHC MedicareMax FL-0028 H5420-001.',
            },
          },
        ],
      }),
    }), async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content: 'Compare H1036-054C, H4140-023, and H5420-001 for Mr. and Mrs. Muskat.',
          },
        ],
        processToolFn: async () => {
          stubbed += 1;
          throw new Error('should not auto-lookup on every comparison');
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(stubbed, 0);
      assert.equal(result.toolResults, undefined);
    });
  });

  it('does not AutoTool a Padron-length doctor/Rx ask when the model dumps the Florida grid', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    const gridDump = Array.from({ length: 90 }, (_, i) => `H10${String(i).padStart(2, '0')}-${String(i).padStart(3, '0')}`).join(', ');
    let stubbed = 0;
    await withMockedFetch(() => ({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-padron',
        model: 'grok-4.6',
        choices: [
          {
            message: {
              role: 'assistant',
              content: `Florida 2027 grid: ${gridDump}. Checking doctors and Jardiance / Mounjaro.`,
            },
          },
        ],
      }),
    }), async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [
          {
            role: 'user',
            content:
              'Maria and Gaspar Padron ZIP 33332. Need to check these doctors: Ernesto Padron PCP plus several specialists. Meds: Jardiance and Mounjaro.',
          },
        ],
        processToolFn: async () => {
          stubbed += 1;
          throw new Error('should not AutoTool the whole Florida grid');
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(stubbed, 0);
      assert.equal(result.toolResults, undefined);
    });
  });

  it('caps a Grok lookup_sob_benefit tool call that passes the whole grid', async () => {
    const { passThroughChat, capToolPlanIds } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    const grid = Array.from({ length: 90 }, (_, i) => `H9998-${String(i + 1).padStart(3, '0')}`);
    const capped = capToolPlanIds('lookup_sob_benefit', { planIds: grid, benefits: ['skilled_nursing'] });
    assert.equal(capped.planIds.length, 8);
    assert.equal(capped.planIds[0], 'H9998-001');
    const stubCalls = [];
    let round = 0;
    await withMockedFetch(() => {
      round += 1;
      const first = round === 1;
      return {
        ok: true,
        json: async () => ({
          id: first ? 'chatcmpl-cap1' : 'chatcmpl-cap2',
          model: 'grok-4.6',
          choices: [
            {
              message: first
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_sob',
                        type: 'function',
                        function: {
                          name: 'lookup_sob_benefit',
                          arguments: JSON.stringify({ planIds: grid, benefits: ['skilled_nursing'] }),
                        },
                      },
                    ],
                  }
                : { role: 'assistant', content: 'SNF lookup finished. Unverified — do not invent dollars.' },
            },
          ],
        }),
      };
    }, async () => {
      await passThroughChat({
        system: 'You are Max.',
        messages: [{ role: 'user', content: 'SNF on the Florida grid please' }],
        processToolFn: async (name, input) => {
          stubCalls.push({ name, input });
          return { text: 'SOB_LOOKUP capped', structured: { cappedFrom: 90 } };
        },
      });
      assert.ok(stubCalls.length >= 1);
      assert.equal(stubCalls[0].input.planIds.length, 8);
      assert.ok(stubCalls.every((c) => !c.input.planIds || c.input.planIds.length <= 8));
    });
  });

  it('returns a partial reply when the chat deadline has already expired', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    await withMockedFetch(() => {
      throw new Error('should not call the model after deadline');
    }, async () => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [{ role: 'user', content: 'hello' }],
        deadlineMs: 1,
      });
      assert.equal(result.deadline, true);
      assert.match(result.content[0].text, /taking longer than the chat wait/i);
    });
  });

  it('does not auto-lookup a single-plan premium question', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    let stubbed = 0;
    await withMockedFetch(() => ({
      ok: true,
      json: async () => ({
        id: 'chatcmpl-prem',
        model: 'grok-4.6',
        choices: [{ message: { role: 'assistant', content: 'H1036-054C premium is $0.' } }],
      }),
    }), async (calls) => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [{ role: 'user', content: 'What is the premium on H1036-054C?' }],
        processToolFn: async () => {
          stubbed += 1;
          throw new Error('should not auto-lookup');
        },
      });
      assert.equal(calls.length, 1);
      assert.equal(stubbed, 0);
      assert.equal(result.toolResults, undefined);
    });
  });
});

describe('Padron chat budget', () => {
  function toolCall(id, name, args) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }

  it('runs a round of 8 doctor tool calls at the same time', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    let round = 0;
    let inFlight = 0;
    let peak = 0;
    await withMockedFetch(() => {
      round += 1;
      const first = round === 1;
      return {
        ok: true,
        json: async () => ({
          id: `chatcmpl-par${round}`,
          model: 'grok-4.6',
          choices: [{
            message: first
              ? { role: 'assistant', content: null, tool_calls: Array.from({ length: 8 }, (_, i) => toolCall(`c${i}`, 'lookup_provider_network', { doctorName: `Doctor ${i}`, zip: '33332' })) }
              : { role: 'assistant', content: 'All 8 doctors checked.' },
          }],
        }),
      };
    }, async () => {
      const started = Date.now();
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [{ role: 'user', content: 'Padron 8 doctors ZIP 33332' }],
        processToolFn: async (name, input) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 150));
          inFlight -= 1;
          return { text: `${input.doctorName}: in network`, structured: { doctorName: input.doctorName, networks: [] } };
        },
      });
      assert.equal(peak, 8);
      assert.ok(Date.now() - started < 800);
      assert.equal(result.deadline, undefined);
      assert.equal(result.toolResults.length, 8);
      assert.match(result.content[0].text, /All 8 doctors/);
    });
  });

  it('cuts a stuck lookup at the tool deadline and still gets a model answer (no deadline banner)', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    let round = 0;
    const seen = [];
    await withMockedFetch((url, body) => {
      round += 1;
      seen.push(body);
      const first = round === 1;
      return {
        ok: true,
        json: async () => ({
          id: `chatcmpl-cut${round}`,
          model: 'grok-4.6',
          choices: [{
            message: first
              ? { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'lookup_provider_network', { doctors: [{ doctorName: 'Howard Bush' }], zip: '33332' })] }
              : { role: 'assistant', content: 'Howard Bush: NOT CONFIRMED. Plans: H1036-054, H5420-001.' },
          }],
        }),
      };
    }, async () => {
      const result = await passThroughChat({
        system: 'You are Max.',
        messages: [{ role: 'user', content: 'Check Howard Bush ZIP 33332' }],
        deadlineMs: 5000,
        processToolFn: () => new Promise(() => {}), // never finishes
      });
      assert.equal(round, 2);
      assert.equal(seen[1].tools, undefined, 'final call must not offer tools');
      const toolMsg = seen[1].messages.find((m) => m.role === 'tool');
      assert.match(toolMsg.content, /NOT CONFIRMED/);
      assert.equal(result.deadline, undefined);
      assert.match(result.content[0].text, /NOT CONFIRMED/);
    });
  });

  it('builds a short per-doctor fallback with narrowing questions when the model itself times out', () => {
    const { fallbackFromToolResults } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    const text = fallbackFromToolResults([
      { tool: 'lookup_provider_network', output: { requestedName: 'Jorge Diaz', doctorName: 'JORGE DIAZ', npi: '1111111111', status: 'done', carriersIn: ['Humana'], inNetworkPlans: ['Humana Gold Plus (H1036-065C)', 'Humana Dual Select (H1036-077)'], outOfNetworkPlans: [] } },
      { tool: 'lookup_provider_network', output: { requestedName: 'Howard Bush', doctorName: 'Howard Bush', status: 'timeout', networks: [] } },
    ], 'Maria & Gaspar Padron, ZIP 33332. Check these doctors and suggest 2-3 2027 plans');
    assert.match(text, /- Jorge Diaz \(JORGE DIAZ, NPI 1111111111\): Humana/);
    assert.match(text, /Howard Bush: NOT CONFIRMED/);
    assert.match(text, /Humana Gold Plus \(H1036-065C\) — 1\/2 doctors in/);
    assert.match(text, /Do Maria and Gaspar have Medicaid/);
    assert.doesNotMatch(text, /H1036-065C.*H1036-077.*H1036-065C/s);
  });

  it('says nothing was saved when the deadline hits before any lookup', async () => {
    const { passThroughChat } = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    await withMockedFetch(() => { throw new Error('no model call'); }, async () => {
      const result = await passThroughChat({ system: 'x', messages: [{ role: 'user', content: 'hi' }], deadlineMs: 1 });
      assert.equal(result.resume.resumable, false);
      assert.match(result.content[0].text, /nothing was saved/);
    });
  });

  it('never lets the server deadline exceed the 120s browser wait', () => {
    process.env.MAX_CHAT_DEADLINE_MS = '300000';
    const grok = loadGrok({ provider: 'grok', key: 'test-xai-key' });
    delete process.env.MAX_CHAT_DEADLINE_MS;
    assert.ok(grok.CHAT_DEADLINE_CAP_MS < 120000);
    assert.ok(grok.DEFAULT_CHAT_DEADLINE_MS <= grok.CHAT_DEADLINE_CAP_MS);
  });
});
