'use strict';

// Prompts that should NOT put a session on the board.
//
// Some slash commands are bookkeeping rather than work. `/git-commit-message`
// is the motivating case: it gets run inside an already-open, higher-tier
// session precisely to avoid switching models (or spending that model's tokens)
// just to draft a commit message. Those turns aren't a task, so they shouldn't
// mint a Kanban card.
//
// This module is deliberately dependency-free — no ./store, no HTTP — so
// bin/status.js can consult it in the UserPromptSubmit hook BEFORE it contacts
// or spawns the dashboard server. A skipped prompt therefore costs one small
// file read and nothing else, and a session that only ever runs skipped
// commands never even starts the server.
//
// Suppressing *creation* here is enough to keep the whole session off the
// board: every other hook path (the Stop backstop, model/meta recording,
// external-edit tracking, session-end) no-ops when the card is absent rather
// than creating one. There is no second door.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Optional user override: a JSON array of command names, leading slash
// optional, e.g. ["git-commit-message", "insights"]. Absent or malformed falls
// back to DEFAULT_COMMANDS — a broken file must not silently un-skip
// everything, nor skip everything.
const OVERRIDE_FILE = path.join(DATA_DIR, 'skip-prompts.json');

// One marker file per session that has had a prompt skipped, so that a session
// which *later* does real work can be flagged (see takeRecord). One file per
// session id, only ever written by that session's own hooks, so concurrent
// sessions can't race each other.
const MARKER_DIR = path.join(DATA_DIR, 'skipped-sessions');

// Markers for sessions that were skipped and never came back would otherwise
// accumulate forever. Swept opportunistically whenever one is written.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_COMMANDS = ['git-commit-message'];

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// The configured command list, normalized to bare names ("git-commit-message").
function commands() {
  const raw = readJson(OVERRIDE_FILE);
  if (!Array.isArray(raw)) return DEFAULT_COMMANDS;
  const list = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().replace(/^\/+/, '');
    if (name) list.push(name);
  }
  return list.length ? list : DEFAULT_COMMANDS;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does this prompt invoke a skip-listed command and nothing else? Returns the
// matched command name, or '' when the prompt is real work.
//
// Two shapes are accepted. The hook payload's `prompt` is the raw text typed
// ("/git-commit-message"), while transcripts store the expanded form
// ("<command-name>/git-commit-message</command-name>" followed by the skill
// body). Matching both means this keeps working if the payload ever carries the
// expanded text instead.
//
// The raw form must be a SINGLE line: "/git-commit-message --no-cosign" is
// still just a commit message, but a prompt that runs onto another line is real
// work that happens to open with a slash command.
function match(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return '';
  const text = prompt.trim();
  for (const name of commands()) {
    const esc = escapeRe(name);
    // [ \t] rather than \s for the separator: \s matches \n, which would let
    // "/git-commit-message\nalso fix the tax bug" pass as a bare invocation.
    if (new RegExp('^/' + esc + '(?:[ \\t][^\\n]*)?$').test(text)) return name;
    if (new RegExp('<command-name>\\s*/?' + esc + '\\s*</command-name>').test(text)) return name;
  }
  return '';
}

// Session ids are UUIDs, but never trust one straight into a path.
function markerPath(sessionId) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return safe ? path.join(MARKER_DIR, safe + '.json') : null;
}

function sweep() {
  try {
    const cutoff = Date.now() - MARKER_TTL_MS;
    for (const name of fs.readdirSync(MARKER_DIR)) {
      const file = path.join(MARKER_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (_) { /* raced with another sweep, or not a file */ }
    }
  } catch (_) { /* directory may not exist yet */ }
}

// Remember that this session had a prompt skipped. Best-effort throughout: the
// flag is a nicety and a hook must never fail a prompt over it.
function record(sessionId, command) {
  const file = markerPath(sessionId);
  if (!file) return;
  try {
    if (!fs.existsSync(MARKER_DIR)) fs.mkdirSync(MARKER_DIR, { recursive: true });
    sweep();
    const prev = readJson(file) || {};
    const seen = Array.isArray(prev.commands) ? prev.commands.slice(0, 5) : [];
    if (command && !seen.includes(command)) seen.push(command);
    fs.writeFileSync(file, JSON.stringify({
      count: (Number(prev.count) || 0) + 1,
      commands: seen.slice(0, 5),
      firstAt: typeof prev.firstAt === 'string' ? prev.firstAt : new Date().toISOString(),
    }), 'utf8');
  } catch (_) { /* best effort */ }
}

// Read and consume this session's marker. Called on the first prompt that is
// NOT skipped; whatever comes back rides along on the card-creation POST so the
// new card can show that the session actually started earlier than its
// createdAt suggests.
function takeRecord(sessionId) {
  const file = markerPath(sessionId);
  if (!file) return null;
  // readJson's own existsSync means the common case — every normal prompt in a
  // session that was never skipped — costs one stat and nothing else.
  const rec = readJson(file);
  if (!rec) return null;
  try { fs.unlinkSync(file); } catch (_) { /* raced or locked; the sweep gets it */ }
  if (!(Number(rec.count) > 0)) return null;
  return {
    count: Number(rec.count),
    commands: Array.isArray(rec.commands) ? rec.commands.filter((c) => typeof c === 'string' && c) : [],
    firstAt: typeof rec.firstAt === 'string' ? rec.firstAt : null,
  };
}

module.exports = {
  match: match,
  record: record,
  takeRecord: takeRecord,
  commands: commands,
  DEFAULT_COMMANDS: DEFAULT_COMMANDS,
  OVERRIDE_FILE: OVERRIDE_FILE,
  MARKER_DIR: MARKER_DIR,
};
