/**
 * Local smoke checks (no network, no Anthropic).
 * Run: node scripts/smoke-test.js
 */
const assert = require('assert');
const { parseName, countyForZip } = require('../services/providerNetwork');
const { searchKnowledge, loadKnowledge } = require('../knowledge/loader');
const { parseNarratedToolCall, detectProviderLookupIntent } = require('../services/claude');
const { sunfireAuthorizationHeader } = require('../services/sunfireAuth');
const { extractApiKey } = require('../middleware/auth');

// parseName
assert.strictEqual(parseName('Dr. John Smith MD').lastName, 'Smith');
assert.strictEqual(parseName('Dr. John Smith MD').firstName, 'John');
assert.strictEqual(parseName('Smith, Jane').lastName, 'Smith');
assert.strictEqual(parseName('Smith, Jane').firstName, 'Jane');

// county map
assert.strictEqual(countyForZip('33312'), '12011');
assert.strictEqual(countyForZip('33136'), '12086');

// knowledge loads json + md
const kb = loadKnowledge();
assert.ok(Object.keys(kb).length > 10);
assert.ok(kb['csnp-conditions-data'], 'json KB file should load');
const hits = searchKnowledge('Humana non-commissionable');
assert.ok(hits.length >= 1);
assert.ok(hits.length <= 6);

// narrated tool parse
const narrated = parseNarratedToolCall(
  'Looking up...\n<tool_call>{"name":"lookup_provider_network","arguments":{"doctorName":"Tharkur","zip":"33136"}}</tool_call>'
);
assert.strictEqual(narrated.name, 'lookup_provider_network');
assert.strictEqual(narrated.input.doctorName, 'Tharkur');

const intent = detectProviderLookupIntent([
  { role: 'user', content: 'What plans is Dr. Jeremy Tharkur in network for?' },
]);
assert.ok(intent?.doctorName);
assert.match(intent.doctorName, /Tharkur/i);

// sunfire auth normalization
process.env.SUNFIRE_JWT = 'abc.def';
assert.strictEqual(sunfireAuthorizationHeader(), 'Bearer abc.def');
process.env.SUNFIRE_JWT = 'Bearer already';
assert.strictEqual(sunfireAuthorizationHeader(), 'Bearer already');

// auth header extract
const key = extractApiKey({
  get: (h) => (h === 'x-max-api-key' ? 'secret' : ''),
});
assert.strictEqual(key, 'secret');

console.log('smoke-test: all checks passed');
