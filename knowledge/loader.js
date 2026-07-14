// knowledge/loader.js — loads max-knowledge markdown files into memory
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, '../../max-knowledge');

let _cache = null;

function loadKnowledge() {
  if (_cache) return _cache;

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

function searchKnowledge(query) {
  const k = loadKnowledge();
  const q = query.toLowerCase();
  const results = [];
  for (const [key, content] of Object.entries(k)) {
    if (content.toLowerCase().includes(q) || key.toLowerCase().includes(q)) {
      results.push({ key, content });
    }
  }
  return results;
}

module.exports = { loadKnowledge, getKnowledgeSummary, getKnowledgeByKey, searchKnowledge };
