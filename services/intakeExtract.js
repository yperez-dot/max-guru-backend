/**
 * New client intake from screenshots: read provider / med lists out of an image and return plain text the agent
 * reviews and edits in the New client box before anything runs. Nothing is saved, nothing is looked up here.
 */
const { parseDataUrl, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, ALLOWED_MIME } = require('./chatImages');

const SYSTEM = [
  'You read a screenshot of a Medicare client\'s information for an insurance agent and turn it into a short paste.',
  'Output ONLY the paste, no commentary, in exactly this shape (leave out any line you have nothing for):',
  'Client: <name — only if the image shows a client/patient name>',
  'ZIP: <5 digits — only if shown>',
  'Current plan: <plan name and ID if shown>',
  'Doctors: <name>, <name>, ...',
  'Meds: <drug name>, <drug name>, ...',
  'Rules:',
  '- Copy names exactly as shown. Never invent, complete, correct or guess a name, drug, ZIP or plan ID.',
  '- Doctors: people and practices the client sees (PCP, specialists, dentists, clinics). Drop specialty words, ratings and UI labels such as "PCP", "Urologist", "Moderate", "Providers (9)", "Preferred", "Accepting new patients".',
  '- If a doctor has a clinic after a dash ("Alok Shrivastava - Cleveland Clinic"), keep only the person.',
  '- Meds: drug names only; drop doses, quantities and instructions unless the dose is part of the name.',
  '- If the image has no usable client information, output exactly: NOTHING_FOUND',
].join('\n');

function normalizeImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) { const e = new Error('Attach a PNG, JPEG or WebP screenshot.'); e.status = 400; throw e; }
  if (list.length > MAX_IMAGES_PER_MESSAGE) { const e = new Error(`Attach up to ${MAX_IMAGES_PER_MESSAGE} screenshots at a time.`); e.status = 400; throw e; }
  return list.map((raw) => {
    const url = typeof raw === 'string' ? raw : raw && raw.dataUrl;
    const parsed = parseDataUrl(url);
    if (!parsed || !ALLOWED_MIME.has(parsed.mime)) { const e = new Error('That file type is not supported. Use PNG, JPEG or WebP.'); e.status = 400; throw e; }
    if (parsed.bytes.length > MAX_IMAGE_BYTES) { const e = new Error('That image is too large (4 MB max).'); e.status = 400; throw e; }
    return parsed.dataUrl;
  });
}

/** Strip anything that is not the paste itself (code fences, "Here is…"). */
function cleanPaste(text) {
  const t = String(text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  if (!t || /^NOTHING_FOUND\b/i.test(t)) return '';
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:Client|ZIP|Current plan|Doctors|Meds)\s*:/i.test(l))
    .join('\n');
}

async function extractIntake(images, deps = {}) {
  const urls = normalizeImages(images);
  const callModel = deps.callModel || require('./grok').callChatCompletions;
  const data = await callModel({
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Turn this into the paste.' },
        ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    }],
    tools: null,
    maxTokens: 900,
    timeoutMs: 45000,
  });
  const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const text = cleanPaste(typeof raw === 'string' ? raw : '');
  return { text, found: Boolean(text) };
}

module.exports = { extractIntake, cleanPaste, normalizeImages, SYSTEM };
