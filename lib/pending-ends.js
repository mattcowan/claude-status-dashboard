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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MARKER_DIR = path.join(DATA_DIR, 'pending-ends');

// A marker older than this is dropped unapplied. A session that ended a week
// ago and was never drained is long past mattering, and a card that has since
// been archived or deleted would otherwise leave its marker behind for good.
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The file name is a SHA-256 of the full session id. Session ids are UUIDs,
// but one is never trusted straight into a path, and the old approach —
// stripping every character outside [A-Za-z0-9._-] — mapped distinct ids to
// one file ("a:b" and "ab" both became ab.json, so the second end overwrote
// the first) and gave an id such as ":" no file at all. A hash keeps every id
// distinct and can never contain a separator or "..". Nothing reads the name
// back: drain() takes the session from the marker's own JSON, which is also
// why markers written under the old naming still drain.
function markerPath(sessionId, dir) {
  const id = sessionId == null ? '' : String(sessionId);
  if (!id) return null;
  const name = crypto.createHash('sha256').update(id, 'utf8').digest('hex');
  return path.join(dir || MARKER_DIR, name + '.json');
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
// `persist()`, when given, must write the applied state to disk and throw if
// it cannot. A marker is the only durable copy of its end until then: apply()
// changes the in-memory board, whose own save is debounced, so a process that
// died between the unlink and that save used to lose the end for good. So a
// fresh marker is deleted only after persist() has succeeded in the same
// drain — whether or not its apply() changed anything, because "no change"
// can also mean an earlier drain applied it and then failed to save. A
// marker whose apply() throws is kept for the next drain; the TTL bounds the
// retries. Markers that are past the TTL or carry no session are deleted
// straight away: no save can make them matter.
//
// A marker that will not parse is renamed aside rather than deleted, the same
// "backed up, not lost" rule readJsonSafe follows — and renamed to a name
// without the .json suffix, so the next drain does not trip over it again.
function drain(apply, dir, persist) {
  const root = dir || MARKER_DIR;
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return 0; } // no dir yet
  const cutoff = Date.now() - MARKER_TTL_MS;
  const unlink = (file) => { try { fs.unlinkSync(file); } catch (_) { /* raced with another drain */ } };
  const consumed = [];
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
    const t = rec && typeof rec.at === 'string' ? Date.parse(rec.at) : NaN;
    const fresh = isFinite(t) && t >= cutoff;
    if (!fresh || !rec || typeof rec.session !== 'string' || !rec.session) {
      unlink(file);
      continue;
    }
    try {
      if (apply(rec.session, rec.at)) applied += 1;
      consumed.push(file);
    } catch (_) { /* kept for the next drain; must not strand the rest of the queue */ }
  }
  if (consumed.length && persist) {
    try { persist(); } catch (_) { return applied; } // keep them all; retry next drain
  }
  consumed.forEach(unlink);
  return applied;
}

module.exports = { write, drain, markerPath, MARKER_DIR, MARKER_TTL_MS };
