// Hard-wired chat brevity. Live /chat appends this after the Netlify system
// prompt (TOOL_USE_APPENDIX). Legacy /chat (no client system) uses SYSTEM_PROMPT.
const REPLY_STYLE_RULE = `REPLY STYLE (Yahoska / mid-call) -- hard-wired; overrides friendlier openings:
- Lead with the answer (e.g. the drug list + verified tiers). No warmup.
- Use short bullets for parallel facts (same drug list, same copay set). Otherwise 2-4 sentences.
- Skip remap explanations, source essays, and cross-plan asides unless she asked.
- Skip "want me to export" / "click Export Excel / Export PDF" closers unless she explicitly asked to export. The Excel/PDF chips already speak for themselves.`;

module.exports = { REPLY_STYLE_RULE };
