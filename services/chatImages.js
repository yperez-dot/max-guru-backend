// Image attach helpers for /chat.
// Accept PNG / JPEG / WebP data URLs or content parts, validate size/type,
// and normalize to OpenAI/Grok vision `image_url` parts. Nothing is written to disk.

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const IMAGE_TOKEN_FLOOR = 765;
const IMAGE_BYTES_PER_TOKEN = 768;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_ALIASES = { 'image/jpg': 'image/jpeg' };

class ImageValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ImageValidationError';
    this.status = status;
    this.code = 'invalid_image';
  }
}

function normalizeMime(mime) {
  const raw = String(mime || '').toLowerCase().split(';')[0].trim();
  return MIME_ALIASES[raw] || raw;
}

function isAllowedMime(mime) {
  return ALLOWED_MIME.has(normalizeMime(mime));
}

function decodeBase64(b64) {
  const cleaned = String(b64 || '').replace(/\s+/g, '');
  if (!cleaned) return null;
  try {
    const bytes = Buffer.from(cleaned, 'base64');
    return bytes.length ? bytes : null;
  } catch (_) {
    return null;
  }
}

function parseDataUrl(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mime = normalizeMime(match[1]);
  const bytes = decodeBase64(match[2]);
  if (!bytes) return null;
  return {
    mime,
    bytes,
    dataUrl: `data:${mime};base64,${match[2].replace(/\s+/g, '')}`,
  };
}

function estimateImageTokens(byteLength) {
  const bytes = Math.max(0, Number(byteLength) || 0);
  if (!bytes) return 0;
  return Math.max(IMAGE_TOKEN_FLOOR, Math.ceil(bytes / IMAGE_BYTES_PER_TOKEN));
}

function imagePartFromDataUrl(dataUrl, label = 'image') {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new ImageValidationError(
      `That ${label} is not a valid PNG, JPEG, or WebP data URL.`
    );
  }
  if (!isAllowedMime(parsed.mime)) {
    throw new ImageValidationError('Images must be PNG, JPEG, or WebP.');
  }
  if (parsed.bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError('Each image must be 4MB or smaller.');
  }
  return {
    type: 'image_url',
    image_url: { url: parsed.dataUrl },
    _bytes: parsed.bytes.length,
  };
}

function extractImageUrl(part) {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.image_url === 'string') return part.image_url;
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
  if (typeof part.url === 'string') return part.url;
  return '';
}

function partToImage(part) {
  const url = extractImageUrl(part);
  if (url) {
    if (/^https?:\/\//i.test(url)) {
      throw new ImageValidationError(
        'Remote image URLs are not allowed. Attach a PNG, JPEG, or WebP as a data URL.'
      );
    }
    return imagePartFromDataUrl(url);
  }

  const source = part.source && typeof part.source === 'object' ? part.source : null;
  const mediaType = normalizeMime(source?.media_type || source?.mediaType || part.media_type || part.mime);
  const data = source?.data || part.data;
  if (data && typeof data === 'string') {
    if (!isAllowedMime(mediaType)) {
      throw new ImageValidationError('Images must be PNG, JPEG, or WebP.');
    }
    return imagePartFromDataUrl(`data:${normalizeMime(mediaType)};base64,${data}`);
  }

  throw new ImageValidationError('Images must be PNG, JPEG, or WebP data URLs.');
}

function isImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') return true;
  if (part.image_url || part.source) return true;
  return false;
}

function isTextPart(part) {
  if (!part || typeof part !== 'object') return false;
  return part.type === 'text' || typeof part.text === 'string';
}

function stripInternal(part) {
  if (!part || typeof part !== 'object') return part;
  if (part.type === 'image_url') {
    return { type: 'image_url', image_url: { url: part.image_url.url } };
  }
  return part;
}

function normalizeContent(content, { validate = true } = {}) {
  if (content == null) return '';
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('data:image/')) {
      return [stripInternal(imagePartFromDataUrl(trimmed))];
    }
    return content;
  }

  if (!Array.isArray(content)) {
    return String(content);
  }

  const parts = [];
  let imageCount = 0;
  for (const raw of content) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('data:image/')) {
        imageCount += 1;
        if (validate && imageCount > MAX_IMAGES_PER_MESSAGE) {
          throw new ImageValidationError('You can attach up to 4 images per message.');
        }
        parts.push(stripInternal(imagePartFromDataUrl(trimmed)));
        continue;
      }
      if (raw) parts.push({ type: 'text', text: raw });
      continue;
    }
    if (isImagePart(raw)) {
      imageCount += 1;
      if (validate && imageCount > MAX_IMAGES_PER_MESSAGE) {
        throw new ImageValidationError('You can attach up to 4 images per message.');
      }
      parts.push(stripInternal(partToImage(raw)));
      continue;
    }
    if (isTextPart(raw)) {
      parts.push({ type: 'text', text: raw.text || '' });
      continue;
    }
    if (validate && raw && typeof raw === 'object' && raw.type) {
      throw new ImageValidationError('Images must be PNG, JPEG, or WebP.');
    }
  }

  if (!parts.length) return '';
  const hasImage = parts.some((part) => part.type === 'image_url');
  if (!hasImage) {
    return parts.map((part) => part.text || '').join('\n');
  }
  return parts;
}

function normalizeMessages(messages, { validate = true } = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    const err = new Error('messages array required');
    err.status = 400;
    err.code = 'invalid_messages';
    throw err;
  }
  return messages.map((message) => {
    const role = message?.role || 'user';
    const content = normalizeContent(message?.content, { validate });
    const out = { role, content };
    if (message?.tool_calls) out.tool_calls = message.tool_calls;
    if (message?.tool_call_id) out.tool_call_id = message.tool_call_id;
    if (message?.name) out.name = message.name;
    return out;
  });
}

function extractPlainText(content) {
  if (typeof content === 'string') {
    return content.trim().startsWith('data:image/') ? '' : content;
  }
  if (!Array.isArray(content)) return String(content || '');
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part.trim().startsWith('data:image/') ? '' : part;
      }
      return part && (part.type === 'text' || typeof part.text === 'string') ? part.text || '' : '';
    })
    .filter(Boolean)
    .join(' ');
}

function summarizeContentForEstimate(content) {
  if (content == null) return { textChars: 0, imageTokens: 0 };
  if (typeof content === 'string') {
    if (content.trim().startsWith('data:image/')) {
      const parsed = parseDataUrl(content);
      return { textChars: 0, imageTokens: estimateImageTokens(parsed?.bytes.length || 0) };
    }
    return { textChars: content.length, imageTokens: 0 };
  }
  if (!Array.isArray(content)) {
    return { textChars: String(content).length, imageTokens: 0 };
  }

  let textChars = 0;
  let imageTokens = 0;
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.trim().startsWith('data:image/')) {
        const parsed = parseDataUrl(part);
        imageTokens += estimateImageTokens(parsed?.bytes.length || 0);
      } else {
        textChars += part.length;
      }
      continue;
    }
    if (isTextPart(part)) {
      textChars += String(part.text || '').length;
      continue;
    }
    if (isImagePart(part)) {
      const url = extractImageUrl(part);
      const parsed = parseDataUrl(url);
      if (parsed) {
        imageTokens += estimateImageTokens(parsed.bytes.length);
        continue;
      }
      const data = part.source?.data || part.data;
      const bytes = decodeBase64(data);
      imageTokens += estimateImageTokens(bytes?.length || IMAGE_TOKEN_FLOOR);
    }
  }
  return { textChars, imageTokens };
}

function countImagesInMessages(messages) {
  return (messages || []).reduce((total, message) => {
    const content = message?.content;
    if (typeof content === 'string') {
      return total + (content.trim().startsWith('data:image/') ? 1 : 0);
    }
    if (!Array.isArray(content)) return total;
    return total + content.filter((part) => isImagePart(part) || (typeof part === 'string' && part.trim().startsWith('data:image/'))).length;
  }, 0);
}

module.exports = {
  ALLOWED_MIME,
  IMAGE_TOKEN_FLOOR,
  ImageValidationError,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  countImagesInMessages,
  estimateImageTokens,
  extractPlainText,
  normalizeContent,
  normalizeMessages,
  parseDataUrl,
  summarizeContentForEstimate,
};
