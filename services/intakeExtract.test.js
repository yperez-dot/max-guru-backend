const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractIntake, cleanPaste } = require('./intakeExtract');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const reply = (text) => async () => ({ choices: [{ message: { content: text } }] });

describe('New client screenshot intake', () => {
  it('returns only the labeled lines (drops chatter and fences)', async () => {
    const out = await extractIntake([PNG], { callModel: reply('Here you go:\n```\nDoctors: Randeep Gadh, Nicole Nicophene\nMeds: lisinopril\n```') });
    assert.equal(out.text, 'Doctors: Randeep Gadh, Nicole Nicophene\nMeds: lisinopril');
    assert.equal(out.found, true);
  });
  it('NOTHING_FOUND means no text', async () => {
    const out = await extractIntake([PNG], { callModel: reply('NOTHING_FOUND') });
    assert.equal(out.found, false);
  });
  it('rejects non-images and empty uploads', async () => {
    await assert.rejects(() => extractIntake([], { callModel: reply('x') }), /Attach a PNG/);
    await assert.rejects(() => extractIntake(['data:application/pdf;base64,AAAA'], { callModel: reply('x') }), /not supported/);
  });
  it('sends the images to the model as image_url parts', async () => {
    let seen;
    await extractIntake([PNG], { callModel: async (req) => { seen = req; return { choices: [{ message: { content: 'Meds: a' } }] }; } });
    assert.equal(seen.messages[0].content.filter((p) => p.type === 'image_url').length, 1);
    assert.match(seen.system, /Never invent/);
  });
  it('cleanPaste keeps Client/ZIP/Current plan/Doctors/Meds only', () => {
    assert.equal(cleanPaste('Client: A B\nZIP: 33324\nsomething else\nCurrent plan: H5431-021'), 'Client: A B\nZIP: 33324\nCurrent plan: H5431-021');
  });
});
