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
