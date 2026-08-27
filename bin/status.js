#!/usr/bin/env node
'use strict';

// Single CLI entrypoint for the Claude Session Status Dashboard.
//
// Hook subcommands (fed hook JSON on stdin by Claude Code):
//   hook-session-start   hook-stop   hook-post-edit   hook-session-end
//
// Claude-facing subcommands (called via Bash; resolve session from cwd):
//   set --headline "…" --body "…"       -> keep/move card to Working
//   note --bullet "…"                    -> append a bullet to the body
//   needs-input [--body "…"]             -> deliberate hand-off (Needs Input)
//   done-for-review                      -> ready for review (Task Completed)
//
// Utility:
//   ensure-server        start the dashboard server if it is not running
//   url                  print the dashboard URL
//   whoami               print the session id the CLI would resolve for this cwd

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const config = require('../lib/config');
const { normalizePath } = require('../lib/store');
const transcript = require('../lib/transcript');
const skipPrompts = require('../lib/skip-prompts');

// ---------- tiny HTTP client ----------

function request(method, reqPath, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: config.HOST,
      port: config.resolvePort(),
      path: reqPath,
      method: method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
        : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* ignore */ }
        resolve({ ok: res.statusCode < 400, status: res.statusCode, json: json });
      });
    });
    req.on('error', () => resolve({ ok: false, status: 0, json: null, down: true }));
    req.setTimeout(timeoutMs || 4000, () => { req.destroy(); resolve({ ok: false, status: 0, json: null, down: true }); });
    if (data) req.write(data);
    req.end();
  });
}

// ---------- server lifecycle ----------

async function isHealthy() {
  const r = await request('GET', '/api/health', null, 500);
  return r.ok && r.json && r.json.ok;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureServer() {
  if (await isHealthy()) return true;
  // Spawn detached so it outlives this short-lived hook/CLI process.
  try {
    if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
    const out = fs.openSync(config.logFile, 'a');
    const child = spawn(process.execPath, [config.serverPath], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
  } catch (err) {
    process.stderr.write('[status] could not spawn server: ' + err.message + '\n');
    return false;
  }
  // Poll for readiness (up to ~5s).
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    if (await isHealthy()) return true;
  }
  return false;
}

// ---------- input helpers ----------

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2500).unref();
  });
}

async function readHookInput() {
  const raw = await readStdin();
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

// The session id Claude Code exposes to Bash-run commands.
function envSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
}

// Resolve which card a Claude-facing subcommand should target (read-only).
async function resolveSession(args) {
  if (args.session) return args.session;
  if (envSessionId()) return envSessionId();
  const r = await request('GET', '/api/resolve?project=' + encodeURIComponent(process.cwd()));
  if (r.json && r.json.card) return r.json.card.id;
  return null;
}

// Like resolveSession, but if no card exists yet (e.g. a session that started
// before the hooks were installed, or one invoked via /status), create one so
// the update has somewhere to land.
//
// Returns null when the server deliberately refused to create a card — a
// session whose only prompts so far were skip-listed bookkeeping commands
// (see lib/skip-prompts.js) — rather than the id of a card that doesn't
// exist, so callers can report that plainly instead of a confusing 404 on
// the follow-up update.
async function resolveOrCreateSession(args) {
  // A session's own id (explicit flag or the env var Claude Code exposes)
  // uniquely identifies its card — it must win over cwd matching, otherwise a
  // new session in a folder that already has another session's card would
  // hijack it. Ensuring the card just touches it if it already exists.
  const id = args.session || envSessionId();
  if (id) {
    const r = await request('POST', '/api/cards', { session: id, project: process.cwd() });
    if (r.json && r.json.suppressed) return null;
    return id;
  }
  // No session id available (non-Claude-Code invocation): fall back to an
  // existing card for this cwd, else create a stable cwd-keyed one.
  const r = await request('GET', '/api/resolve?project=' + encodeURIComponent(process.cwd()));
  if (r.json && r.json.card) return r.json.card.id;
  const gen = 'cwd-' + Buffer.from(process.cwd()).toString('hex').slice(0, 16);
  await request('POST', '/api/cards', { session: gen, project: process.cwd() });
  return gen;
}

function isUnder(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '\\');
}

// ---------- subcommand handlers ----------

// Fires on the user's FIRST (and every) prompt. Creates the session's card the
// moment a real question is asked, so opening an empty chat never makes a
// ticket. Idempotent: after the first prompt it just refreshes the card.
async function hookUserPrompt() {
  const input = await readHookInput();
  const session = input.session_id;
  const cwd = input.cwd || process.cwd();

  // Bookkeeping commands (/git-commit-message and anything else on the skip
  // list) don't earn a card. Checked BEFORE ensureServer() so a session that
  // only ever runs one never even starts the dashboard.
  //
  // This also skips the refresh POST for sessions that already HAVE a card,
  // which is harmless: the Stop hook bumps their activity clock a moment later.
  const skipped = skipPrompts.match(input.prompt);
  if (skipped) {
    if (session) skipPrompts.record(session, skipped);
    // Tell the dashboard, so a session that already HAS a card gets tagged with
    // the command it just ran. Posted directly rather than through
    // ensureServer(): the whole point of this branch is that a bookkeeping
    // prompt must never start the server, so when nothing is listening the
    // request fails fast on ECONNREFUSED and the tag is simply lost. The
    // marker file record() just wrote is the durable half — if this session
    // goes on to real work, the tag arrives with skippedBefore instead.
    if (session) {
      const r = await request('POST', '/api/hook/skipped-command',
        { session: session, command: skipped, project: cwd }, 1500);
      // "no card yet" is the normal answer and says nothing. "rejected" means
      // the skip list holds a name this can't store, which is a configuration
      // mistake the user should be able to find — stderr, because a hook must
      // still exit 0 and must never write to stdout.
      if (r.json && r.json.reason === 'rejected') {
        process.stderr.write('[status] /' + skipped + ' is on the skip list but is not a ' +
          'storable command name, so the session was not tagged.\n');
      }
    }
    process.exit(0);
  }

  await ensureServer();
  if (session) {
    // Best-effort model read (may be empty on a session's very first prompt,
    // before any assistant line exists — hook-stop backfills it).
    const model = transcript.lastAssistantModel(input.transcript_path);
    // Title/slug/branch from the transcript. The ai-title only exists after
    // the first assistant turn, so hook-stop is the reliable carrier; empty
    // values never clobber stored ones server-side.
    const meta = transcript.sessionMeta(input.transcript_path);
    await request('POST', '/api/cards', {
      session, project: cwd, source: 'prompt', model,
      aiTitle: meta.aiTitle, slug: meta.slug, gitBranch: meta.gitBranch,
      transcriptPath: input.transcript_path || '',
      // Non-null only when earlier turns in this session were skipped. The
      // server ignores it unless this POST is the one that mints the card, so
      // a mid-session /git-commit-message never flags an established card.
      skippedBefore: skipPrompts.takeRecord(session),
    });
  }
  process.exit(0);
}

// Legacy: kept for anyone wiring SessionStart, but no longer used by default.
async function hookSessionStart() {
  const input = await readHookInput();
  await ensureServer();
  const session = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (session) {
    await request('POST', '/api/cards', { session, project: cwd, source: input.source || 'startup' });
  }
  process.exit(0);
}

async function hookStop() {
  const input = await readHookInput();
  await ensureServer();
  const session = input.session_id;
  if (session) {
    const leftOff = transcript.lastAssistantText(input.transcript_path, 280);
    const model = transcript.lastAssistantModel(input.transcript_path);
    const meta = transcript.sessionMeta(input.transcript_path);
    await request('POST', '/api/hook/stop', {
      session, leftOff, model,
      aiTitle: meta.aiTitle, slug: meta.slug, gitBranch: meta.gitBranch,
      transcriptPath: input.transcript_path || '',
    });
  }
  process.exit(0);
}

async function hookPostEdit() {
  const input = await readHookInput();
  const session = input.session_id;
  const cwd = input.cwd || process.cwd();
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
  // Only act on external edits; in-project edits exit fast (keeps per-edit cost low).
  if (session && filePath && !isUnder(filePath, cwd)) {
    await ensureServer();
    await request('POST', '/api/cards/' + encodeURIComponent(session) + '/external-edit', { file: filePath });
  }
  process.exit(0);
}

async function hookSessionEnd() {
  const input = await readHookInput();
  await ensureServer();
  const session = input.session_id;
  if (session) {
    await request('POST', '/api/hook/session-end', { session });
  }
  process.exit(0);
}

async function claudeUpdate(fields, label) {
  const args = parseArgs(process.argv.slice(3));
  await ensureServer();
  const session = await resolveOrCreateSession(args);
  if (!session) {
    process.stderr.write('[status] No card created: this session has only run skip-listed ' +
      'bookkeeping commands (e.g. /git-review, /git-commit-message) so far — see ' +
      'lib/skip-prompts.js. If real work follows, the next prompt will create the card.\n');
    process.exit(1);
  }
  // Merge CLI-provided text into the update.
  if ('headline' in args && typeof args.headline === 'string') fields.headline = args.headline;
  if ('body' in args && typeof args.body === 'string') fields.body = args.body;
  if ('bullet' in args && typeof args.bullet === 'string') fields.appendBullet = args.bullet;

  const r = await request('POST', '/api/cards/' + encodeURIComponent(session), fields);
  if (!r.ok) {
    process.stderr.write('[status] update failed (' + r.status + ').\n');
    process.exit(1);
  }
  process.stdout.write('[status] ' + label + ' — card ' + session + '\n');
  process.exit(0);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'hook-user-prompt': return hookUserPrompt();
    case 'hook-session-start': return hookSessionStart();
    case 'hook-stop': return hookStop();
    case 'hook-post-edit': return hookPostEdit();
    case 'hook-session-end': return hookSessionEnd();

    case 'set': return claudeUpdate({ column: 'working', auto: false }, 'Working');
    case 'note': return claudeUpdate({ auto: false }, 'noted');
    case 'needs-input': return claudeUpdate({ column: 'needs_input', auto: false }, 'Needs Input');
    case 'done-for-review': return claudeUpdate({ column: 'task_completed', auto: false }, 'Ready for Review');

    case 'ensure-server': {
      const ok = await ensureServer();
      process.stdout.write(ok ? ('[status] server up at ' + config.baseUrl() + '\n')
                               : '[status] server did NOT come up\n');
      process.exit(ok ? 0 : 1);
      return;
    }
    case 'url':
      process.stdout.write(config.baseUrl() + '\n');
      process.exit(0);
      return;
    case 'whoami': {
      const session = await resolveSession(parseArgs(process.argv.slice(3)));
      process.stdout.write((session || '(none)') + '\n');
      process.exit(0);
      return;
    }
    default:
      process.stderr.write('Usage: status.js <hook-user-prompt|hook-stop|hook-post-edit|hook-session-end|' +
        'set|note|needs-input|done-for-review|ensure-server|url|whoami> [--flags]\n');
      process.exit(1);
  }
}

main();
