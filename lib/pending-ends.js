'use strict';

// Durable "this session ended" markers, for when the SessionEnd hook cannot
// reach the server (issue #32).
//
// Why this exists: Claude Code bounds the whole SessionEnd phase with a short
// timeout — 1.5 s by default, shared by every SessionEnd hook on the event,
// raised only by a per-hook "timeout" or CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
// — and kills whatever is still running when it expires. hook-session-end used
// to call ensureServer() first, which on a down server means a spawn and up to
// five seconds of readiness polling: the one path guaranteed to overrun. The
// hook was killed before its POST, sessionEndedAt was never written, and the
// card sat on "idle" forever, because nothing else ever marks a card ended.
//
// So the hook no longer starts the server. It POSTs once with a short timeout
// and, if nothing answered, writes a marker here instead — one small file
// write, well inside any budget. The server drains the directory at boot and
// on a short interval, and applies each marker with the time the HOOK saw, not
// the time of the drain.
//
// Same file-per-session shape as lib/skip-prompts.js's markers, for the same
// reason: two sessions ending at once never contend for one file.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MARKER_DIR = path.join(DATA_DIR, 'pending-ends');

// A marker older than this is dropped unapplied. A session that ended a week
// ago and was never drained is long past mattering, and a card that has since
// been archived or deleted would otherwise leave its marker behind for good.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Session ids are UUIDs, but never trust one straight into a path. The same
// rule lib/skip-prompts.js applies to its markers.
function markerPath(sessionId, dir) {
  const safe = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return safe ? path.join(dir || MARKER_DIR, safe + '.json') : null;
}

// Record that a session ended while the server was unreachable. Best-effort:
// a hook must never fail over bookkeeping, and the worst outcome of a lost
// marker is the pre-#32 behavior (the card reads "idle"). Returns true when
// the marker was written.
function write(sessionId, at, dir) {
  const file = markerPath(sessionId, dir);
  if (!file) return false;
  // Written to a temp name and renamed into place, so a drain running at the
  // same moment (the POST timed out on a slow server that is still up) never
  // reads a half-written file and sets it aside as corrupt. The temp name
  // lacks the .json suffix, so drain() skips it.
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({
      session: String(sessionId),
      at: typeof at === 'string' && at ? at : new Date().toISOString(),
    }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* never created */ }
    return false;
  }
}

// Apply and remove every marker in the directory. `apply(session, at)` is the
// store's side of it; whatever it returns, the marker is consumed — a marker
// for a session with no card (it never earned one, or was deleted) has nothing
// left to wait for. Returns the number of markers whose apply() reported a
// change, so a caller can log it.
//
// A marker that will not parse is renamed aside rather than deleted, the same
// "backed up, not lost" rule readJsonSafe follows — and renamed to a name
// without the .json suffix, so the next drain does not trip over it again.
function drain(apply, dir) {
  const root = dir || MARKER_DIR;
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return 0; } // no dir yet
  const cutoff = Date.now() - MARKER_TTL_MS;
  let applied = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(root, name);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (__) { /* ignore */ }
      continue;
    }
    try {
      const t = rec && typeof rec.at === 'string' ? Date.parse(rec.at) : NaN;
      const fresh = isFinite(t) && t >= cutoff;
      if (fresh && rec && typeof rec.session === 'string' && rec.session) {
        if (apply(rec.session, rec.at)) applied += 1;
      }
    } catch (_) { /* a throwing apply must not strand the rest of the queue */ }
    try { fs.unlinkSync(file); } catch (_) { /* raced with another drain */ }
  }
  return applied;
}

module.exports = { write, drain, markerPath, MARKER_DIR, MARKER_TTL_MS };
