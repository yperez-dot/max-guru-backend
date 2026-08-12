// knowledge/loader.js — loads max-knowledge markdown + JSON into memory
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '../max-knowledge');
const MAX_SEARCH_RESULTS = 6;
const MAX_RESULT_CHARS = 6000;

let _cache = null;

function loadKnowledge() {
  if (_cache) return _cache;

  const knowledge = {};

  function loadDir(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (entry === 'README.md') continue;
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        loadDir(fullPath, prefix + entry + '/');
      } else if (entry.endsWith('.md')) {
        const key = prefix + entry.replace(/\.md$/, '');
        knowledge[key] = fs.readFileSync(fullPath, 'utf8');
      } else if (entry.endsWith('.json')) {
        const key = prefix + entry.replace(/\.json$/, '');
        const raw = fs.readFileSync(fullPath, 'utf8');
        try {
          knowledge[key] = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          knowledge[key] = raw;
        }
      }
    }
  }

  loadDir(KNOWLEDGE_DIR);
  _cache = knowledge;
  console.log(`[Knowledge] Loaded ${Object.keys(knowledge).length} files`);
  return knowledge;
}

function getKnowledgeSummary() {
  const k = loadKnowledge();
  return Object.entries(k).map(([key, content]) => {
    const firstLine = content.split('\n').find(l => l.trim()) || key;
    return `- ${key}: ${firstLine.replace(/^#+\s*/, '').slice(0, 80)}`;
  }).join('\n');
}

function getKnowledgeByKey(key) {
  const k = loadKnowledge();
  return k[key] || null;
}

function searchKnowledge(query) {
  const k = loadKnowledge();
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const [key, content] of Object.entries(k)) {
    const hay = `${key}\n${content}`.toLowerCase();
    if (!hay.includes(q) && !terms.every(t => hay.includes(t))) continue;

    let score = 0;
    if (key.toLowerCase().includes(q)) score += 10;
    if (hay.includes(q)) score += 5;
    for (const t of terms) {
      if (key.toLowerCase().includes(t)) score += 2;
      if (hay.includes(t)) score += 1;
    }
    scored.push({ key, content, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SEARCH_RESULTS).map(({ key, content }) => ({
    key,
    content: content.length > MAX_RESULT_CHARS
      ? `${content.slice(0, MAX_RESULT_CHARS)}\n…[truncated]`
      : content,
  }));
}

module.exports = { loadKnowledge, getKnowledgeSummary, getKnowledgeByKey, searchKnowledge };
