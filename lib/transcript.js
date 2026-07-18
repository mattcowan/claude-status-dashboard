'use strict';

// Best-effort extraction of the last assistant text from a Claude Code
// transcript (JSONL). Used by the Stop-hook backstop to record "where it left
// off" when Claude did not set an explicit status. Never throws.

const fs = require('fs');

function oneLine(text, max) {
  const limit = max || 280;
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ') // collapse fenced code blocks
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > limit) s = s.slice(0, limit - 1).trimEnd() + '…';
  return s;
}

// Pull readable text out of an assistant message's content, which may be a
// plain string or an array of blocks ({type:'text', text} etc.).
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') parts.push(block);
      else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join(' ');
  }
  return '';
}

// Return the model id (e.g. "claude-opus-4-8") from the last assistant line
// that carries one. Same bottom-up scan as lastAssistantText. Never throws;
// returns '' when the transcript has no assistant message with a model yet.
function lastAssistantModel(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }

      const role = evt.role || (evt.message && evt.message.role) || evt.type;
      if (role !== 'assistant') continue;

      const model = evt.message && evt.message.model;
      if (typeof model === 'string' && model) return model;
    }
  } catch (_) { /* best effort */ }
  return '';
}

function lastAssistantText(transcriptPath, max) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }

      // Claude Code transcripts nest the message under `message`, with the role
      // sometimes on the outer object and sometimes on the inner one.
      const role = evt.role || (evt.message && evt.message.role) || evt.type;
      if (role !== 'assistant') continue;

      const content = (evt.message && evt.message.content) != null
        ? evt.message.content
        : evt.content;
      const text = oneLine(extractText(content), max);
      if (text) return text;
    }
  } catch (_) { /* best effort */ }
  return '';
}

// Session metadata Claude Code persists in the transcript itself:
//   - {"type":"ai-title","aiTitle":"…"} lines carry the auto-generated session
//     title (the VS Code tab title); the LAST one wins.
//   - every {"type":"user"} line carries a stable "slug" (also the plan-file
//     name under ~/.claude/plans) and most lines carry "gitBranch".
// One bottom-up pass; never throws. (If the two lastAssistant* scans are ever
// merged, this is the natural home for the combined pass.)
function sessionMeta(transcriptPath) {
  const meta = { aiTitle: '', slug: '', gitBranch: '' };
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return meta;
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }

      if (!meta.aiTitle && evt.type === 'ai-title' && typeof evt.aiTitle === 'string' && evt.aiTitle) {
        meta.aiTitle = evt.aiTitle;
      }
      if (!meta.slug && evt.type === 'user' && typeof evt.slug === 'string' && evt.slug) {
        meta.slug = evt.slug;
      }
      if (!meta.gitBranch && typeof evt.gitBranch === 'string' && evt.gitBranch) {
        meta.gitBranch = evt.gitBranch;
      }
      if (meta.aiTitle && meta.slug && meta.gitBranch) break;
    }
  } catch (_) { /* best effort */ }
  return meta;
}

module.exports = { lastAssistantText, lastAssistantModel, sessionMeta, oneLine };
