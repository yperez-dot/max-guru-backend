// knowledge/loader.js — loads max-knowledge markdown files into memory
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '../max-knowledge');

let _cache = null;

function loadKnowledge({ force = false } = {}) {
  if (_cache && !force) return _cache;

  const knowledge = {};

  // Load all markdown files recursively
  function loadDir(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        loadDir(fullPath, prefix + entry + '/');
      } else if (entry.endsWith('.md')) {
        const key = prefix + entry.replace('.md', '');
        knowledge[key] = fs.readFileSync(fullPath, 'utf8');
      } else if (entry.endsWith('.json') && prefix.startsWith('hub/')) {
        // Keep structured hub dumps searchable as pretty JSON text
        const key = prefix + entry.replace('.json', '');
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          knowledge[key] = `# ${key}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2).slice(0, 200000)}\n\`\`\`\n`;
        } catch (_) {
          knowledge[key] = fs.readFileSync(fullPath, 'utf8').slice(0, 200000);
        }
      }
    }
  }

  loadDir(KNOWLEDGE_DIR);
  _cache = knowledge;
  console.log(`[Knowledge] Loaded ${Object.keys(knowledge).length} files:`, Object.keys(knowledge).join(', '));
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

function excerptAround(content, query, radius = 1200) {
  const lower = content.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return content.slice(0, 8000);
  const terms = q.split(/\s+/).filter(Boolean);
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return content.slice(0, 8000);
  const start = Math.max(0, best - radius);
  const end = Math.min(content.length, best + radius);
  const chunk = content.slice(start, end);
  return `${start > 0 ? '…' : ''}${chunk}${end < content.length ? '…' : ''}`;
}

function searchKnowledge(query, { limit = 8 } = {}) {
  const k = loadKnowledge();
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(t => t.length > 1);
  const scored = [];
  for (const [key, content] of Object.entries(k)) {
    const hay = `${key}\n${content}`.toLowerCase();
    if (!terms.some(t => hay.includes(t)) && !hay.includes(q)) continue;
    let score = 0;
    if (key.toLowerCase().includes(q)) score += 50;
    for (const t of terms) {
      if (key.toLowerCase().includes(t)) score += 12;
      // cheap occurrence count cap
      let idx = 0;
      let hits = 0;
      while (hits < 20) {
        idx = hay.indexOf(t, idx);
        if (idx < 0) break;
        hits += 1;
        idx += t.length;
      }
      score += hits;
    }
    // Prefer Florida SEP file for FL/SEP queries
    if (/sep/.test(q) && /florida|\bfl\b/.test(q) && key.includes('seps-by-state/FL')) score += 40;
    if (/hub\//.test(key)) score += 2;
    scored.push({ key, content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ key, content }) => ({
    key,
    content: content.length > 9000 ? excerptAround(content, q) : content,
  }));
}

module.exports = {
  loadKnowledge,
  getKnowledgeSummary,
  getKnowledgeByKey,
  searchKnowledge,
};
