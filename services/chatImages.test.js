const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  ImageValidationError,
  MAX_IMAGE_BYTES,
  estimateImageTokens,
  extractPlainText,
  normalizeMessages,
  summarizeContentForEstimate,
} = require('./chatImages');

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG = `data:image/png;base64,${TINY_PNG_B64}`;
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const TINY_WEBP =
  'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const TINY_GIF =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function oversizedPngDataUrl() {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

describe('chat image payload validation', () => {
  it('keeps plain string messages unchanged', () => {
    const out = normalizeMessages([{ role: 'user', content: 'Humana H7617-145 MOOP?' }]);
    assert.deepEqual(out, [{ role: 'user', content: 'Humana H7617-145 MOOP?' }]);
  });

  it('joins text-only content parts back to a string', () => {
    const out = normalizeMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'CarePlus CareComplete' },
          { type: 'text', text: 'crowns?' },
        ],
      },
    ]);
    assert.equal(out[0].content, 'CarePlus CareComplete\ncrowns?');
  });

  it('accepts png/jpeg/webp data URLs and forwards OpenAI image_url parts', () => {
    const out = normalizeMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What plan is this SoB?' },
          { type: 'image_url', image_url: { url: TINY_PNG } },
          { type: 'image_url', image_url: { url: TINY_JPEG } },
          { type: 'image_url', image_url: TINY_WEBP },
        ],
      },
    ]);
    assert.equal(out[0].role, 'user');
    assert.ok(Array.isArray(out[0].content));
    assert.deepEqual(out[0].content[0], { type: 'text', text: 'What plan is this SoB?' });
    assert.deepEqual(out[0].content[1], { type: 'image_url', image_url: { url: TINY_PNG } });
    assert.equal(out[0].content[2].image_url.url.startsWith('data:image/jpeg;base64,'), true);
    assert.equal(out[0].content[3].image_url.url.startsWith('data:image/webp;base64,'), true);
    assert.equal(JSON.stringify(out[0]).includes('_bytes'), false);
  });

  it('normalizes Anthropic-style image parts and lone data URLs', () => {
    const out = normalizeMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
          },
        ],
      },
      { role: 'user', content: TINY_JPEG },
    ]);
    assert.deepEqual(out[0].content, [{ type: 'image_url', image_url: { url: TINY_PNG } }]);
    assert.deepEqual(out[1].content, [{ type: 'image_url', image_url: { url: TINY_JPEG } }]);
  });

  it('rejects GIF and other non-allowed types', () => {
    assert.throws(
      () =>
        normalizeMessages([
          { role: 'user', content: [{ type: 'image_url', image_url: { url: TINY_GIF } }] },
        ]),
      (err) => err instanceof ImageValidationError && /PNG, JPEG, or WebP/i.test(err.message)
    );
  });

  it('rejects remote http image URLs', () => {
    assert.throws(
      () =>
        normalizeMessages([
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/sob.png' } }],
          },
        ]),
      (err) => err instanceof ImageValidationError && /Remote image URLs/i.test(err.message)
    );
  });

  it('rejects images over 4MB', () => {
    assert.throws(
      () =>
        normalizeMessages([
          { role: 'user', content: [{ type: 'image_url', image_url: { url: oversizedPngDataUrl() } }] },
        ]),
      (err) => err instanceof ImageValidationError && /4MB or smaller/i.test(err.message)
    );
  });

  it('rejects more than 4 images on one message', () => {
    const images = Array.from({ length: 5 }, () => ({
      type: 'image_url',
      image_url: { url: TINY_PNG },
    }));
    assert.throws(
      () => normalizeMessages([{ role: 'user', content: images }]),
      (err) => err instanceof ImageValidationError && /up to 4 images/i.test(err.message)
    );
  });
});

describe('chat image text / token helpers', () => {
  it('extracts override text from a multimodal user turn', () => {
    assert.equal(
      extractPlainText([
        { type: 'text', text: 'OK go over' },
        { type: 'image_url', image_url: { url: TINY_PNG } },
      ]),
      'OK go over'
    );
    assert.equal(extractPlainText(TINY_PNG), '');
  });

  it('counts image tokens without stuffing the raw data URL into the estimate', () => {
    const textOnly = summarizeContentForEstimate('short');
    assert.equal(textOnly.textChars, 5);
    assert.equal(textOnly.imageTokens, 0);

    const withImage = summarizeContentForEstimate([
      { type: 'text', text: 'short' },
      { type: 'image_url', image_url: { url: TINY_PNG } },
    ]);
    assert.equal(withImage.textChars, 5);
    assert.equal(withImage.imageTokens, estimateImageTokens(Buffer.from(TINY_PNG_B64, 'base64').length));
    assert.ok(withImage.imageTokens >= 765);
  });
});
