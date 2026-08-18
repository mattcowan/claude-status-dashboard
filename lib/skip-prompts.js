'use strict';

// Prompts that should NOT put a session on the board.
//
// Some slash commands are bookkeeping rather than work. `/git-commit-message`
// is the motivating case: it gets run inside an already-open, higher-tier
// session precisely to avoid switching models (or spending that model's tokens)
// just to draft a commit message. Those turns aren't a task, so they shouldn't
// mint a Kanban card. `/git-review` is the same shape — a read-only pre-commit
// gate over changes some other session already made.
//
// This module is deliberately dependency-free — no ./store, no HTTP — so
// bin/status.js can consult it in the UserPromptSubmit hook BEFORE it contacts
// or spawns the dashboard server. A session that only ever runs skipped
// commands therefore never even starts the server.
//
// Cost: the match itself is one small file read (the override list). A prompt
// that actually matches then goes on to record() a marker, which sweeps the
// marker directory first — a readdir plus a stat per marker — and then reads
// and writes the marker itself. Still all local file I/O, but not free, and it
// scales with the number of live markers rather than being constant.
//
// Suppressing *creation* here is enough to keep the whole session off the
// board: every other hook path (the Stop backstop, model/meta recording,
// external-edit tracking, session-end) no-ops when the card is absent rather
// than creating one.
//
// There is a second door, though: bin/status.js's Claude-facing subcommands
// (set/note/needs-input/done-for-review) hit the same card-creating endpoint
// via resolveOrCreateSession(), with no awareness of the skip list — if
// Claude calls one of those out of habit during a skip-listed-only session
// (e.g. following the "declare the outcome" convention at end of turn), it
// would otherwise mint an empty card the hook had just refused to create.
// server.js closes this by checking hasPendingSkip() itself before creating
// any *new* card, regardless of which caller's POST it came from.

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

// Add a command here to skip it for every install; data/skip-prompts.json
// overrides this list per machine (and, being under the gitignored data/, is
// the right place for commands specific to one person's setup).
const DEFAULT_COMMANDS = ['git-commit-message', 'git-review'];

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

// The wrapper lines Claude Code writes around an expanded slash command. Each
// must sit on its own line and close on that same line — `[^\n<]` rather than
// `\s`/`.` so a newline can never slip inside a tag.
const COMMAND_LINE_RE = /^<command-(name|message|args)>[^\n<]*<\/command-\1>$/;
const COMMAND_NAME_RE = /^<command-name>\s*\/?([^<\s]+)\s*<\/command-name>$/;

// The command named by an expanded invocation, or '' if this isn't one.
//
// Requiring EVERY non-empty line to be a command wrapper is what keeps prose
// out: a prompt that merely quotes "<command-name>/git-commit-message</command-name>"
// (a PR review of this very file, say) has other lines and so reads as real
// work. Anything unrecognized — a wrapper tag Claude Code adds later, an
// unclosed tag — also falls through to '' and gets a card, which is the safe
// direction to fail.
function expandedCommand(text) {
  let found = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!COMMAND_LINE_RE.test(line)) return '';
    const m = COMMAND_NAME_RE.exec(line);
    if (m) found = m[1];
  }
  return found;
}

// Does this prompt invoke a skip-listed command and nothing else? Returns the
// matched command name, or '' when the prompt is real work.
//
// Two shapes are accepted. The hook payload's `prompt` is the raw text typed
// ("/git-commit-message"), while transcripts store the expanded form
// ("<command-message>…</command-message>" plus "<command-name>/…</command-name>",
// with the skill body arriving as a separate message). Matching both means this
// keeps working if the payload ever carries the expanded text instead.
//
// Either way the prompt must be the invocation and nothing more:
// "/git-commit-message --no-cosign" is still just a commit message, but a
// prompt that runs on into prose is real work that happens to mention a slash
// command.
function match(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return '';
  const text = prompt.trim();
  const expanded = expandedCommand(text);
  for (const name of commands()) {
    if (expanded === name) return name;
    // [ \t] rather than \s for the separator: \s matches \n, which would let
    // "/git-commit-message\nalso fix the tax bug" pass as a bare invocation.
    const esc = escapeRe(name);
    if (new RegExp('^/' + esc + '(?:[ \\t][^\\n]*)?$').test(text)) return name;
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

// Peek at whether this session currently has an unconsumed marker, without
// consuming it. A marker exists exactly when every prompt so far in the
// session has been skip-listed and none has yet minted a card — a real
// prompt always takeRecord()s (and thereby deletes) the marker before its
// own card-creating POST lands at the server. Used server-side to stop a
// bookkeeping CLI call (bin/status.js set/note/needs-input/done-for-review)
// from creating a card behind the hook's back for a session that has never
// had real work.
function hasPendingSkip(sessionId) {
  const file = markerPath(sessionId);
  if (!file) return false;
  try { return fs.existsSync(file); } catch (_) { return false; }
}

module.exports = {
  match: match,
  record: record,
  takeRecord: takeRecord,
  hasPendingSkip: hasPendingSkip,
  commands: commands,
  DEFAULT_COMMANDS: DEFAULT_COMMANDS,
  OVERRIDE_FILE: OVERRIDE_FILE,
  MARKER_DIR: MARKER_DIR,
};
