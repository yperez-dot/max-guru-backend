const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_PLAN_YEAR,
  detectPlanYear,
  resolveDocumentYear,
  resolveDocumentUrl,
  conversationAskText,
  attachedPlanYear,
} = require('./planYear');

describe('detectPlanYear / resolveDocumentYear', () => {
  it('uses 2027 when the year is unspecified', () => {
    assert.equal(detectPlanYear('What is the SNF copay on H1609-093?'), 2027);
    assert.equal(resolveDocumentYear({ askText: 'SNF on Aetna Select Care' }), 2027);
    assert.equal(DEFAULT_PLAN_YEAR, 2027);
  });

  it('uses 2026 only when the ask is 2026 and not 2027', () => {
    assert.equal(detectPlanYear('This case is 2026. Hearing aids on H1609-093?'), 2026);
    assert.equal(
      resolveDocumentYear({
        year: 2027,
        askText: 'Yahoska: the case is 2026 — pull the Summary of Benefits for H1036-054C',
      }),
      2026
    );
  });

  it('uses 2027 when she says 2027', () => {
    assert.equal(detectPlanYear('2027 AEP SNF on H1609-093'), 2027);
    assert.equal(resolveDocumentYear({ askText: 'Need the 2027 SOB for CareComplete' }), 2027);
  });

  it('does not guess when both years appear — keeps 2027', () => {
    const both = 'Compare 2026 vs 2027 SNF on H1609-093';
    assert.equal(detectPlanYear(both), 2027);
    assert.equal(resolveDocumentYear({ year: 2026, askText: both }), 2027);
    assert.equal(detectPlanYear(both, 2026), 2027);
  });

  it('honors an explicit year=2026 API flag when the ask does not mention 2027', () => {
    assert.equal(resolveDocumentYear({ year: 2026, askText: 'SNF on H1609-093' }), 2026);
  });

  it('uses attached 2026 PLAN DATA when the toggle/system says 2026 and the ask names no year', () => {
    assert.equal(
      resolveDocumentYear({
        askText: 'Hearing aids on H1609-093',
        systemText: 'ATTACHED_PLAN_YEAR=2026\nPLAN DATA (12 plans attached…)',
      }),
      2026
    );
    assert.equal(
      resolveDocumentYear({
        askText: 'Hearing aids',
        plans: [{ planId: 'H1609-093', year: 2026, sobUrl: 'https://example.com/2026.pdf' }],
      }),
      2026
    );
    assert.equal(attachedPlanYear('rules… ATTACHED_PLAN_YEAR=2026 …'), 2026);
  });

  it('reads only user turns for conversation year, not the 2027 system prompt', () => {
    const ask = conversationAskText([
      { role: 'system', content: 'PLAN DATA is THEI 2027 grid. Never quote 2026 as 2027.' },
      { role: 'user', content: 'This case is 2026. What is SNF on H1609-093?' },
    ]);
    assert.match(ask, /2026/);
    assert.doesNotMatch(ask, /2027/);
    assert.equal(resolveDocumentYear({ askText: ask, systemText: '2027 AEP default' }), 2026);
  });
});

describe('resolveDocumentUrl never crosses years', () => {
  const url26 = 'https://www.aetna.com/medicare/documents/individual/2026/summaryofbenefits/Y0001_H1609_093_NU26_SB2026_M.pdf';
  const url27 = 'https://www.aetna.com/medicare/documents/individual/2027/sb/en/Y0001_H1609_093_HQ26_SB2027_M.pdf';

  it('prefers the wired URL for the asked year', () => {
    assert.equal(resolveDocumentUrl(url27, url26, 2026), url26);
    assert.equal(resolveDocumentUrl(url26, url27, 2027), url27);
  });

  it('drops a wrong-year URL when that year has no wired file', () => {
    assert.equal(resolveDocumentUrl(url27, '', 2026), '');
    assert.equal(resolveDocumentUrl(url26, '', 2027), '');
  });
});
