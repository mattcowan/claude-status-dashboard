'use strict';

// Tests for the SessionEnd path (issue #32): cards stuck on "idle" because the
// hook was killed by Claude Code's 1.5 s SessionEnd bound before its POST.
//
// Two halves, both easy to break without noticing:
//   lib/pending-ends.js        the marker a hook leaves when the server is down,
//                              and the drain that applies it later.
//   Store.markSessionEnded()   must apply a late end with the hook's own time,
//                              and must refuse one older than the card's last
//                              activity — that session was resumed, and ending
//                              it now would mark a live session ended.
//
// Markers go to a throwaway directory under the OS temp dir, never data/, and
// the Store follows store-projects.test.js: a real Store, saves stubbed, board
// replaced by a fixture.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const pendingEnds = require('../lib/pending-ends');

// Real timestamps relative to now: the drain drops markers past a 7-day TTL,
// so a hard-coded date would start failing a week after it was written.
const HOUR = 60 * 60 * 1000;
function hoursAgo(h) { return new Date(Date.now() - h * HOUR).toISOString(); }

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-ends-'));
}

function fixture(cards) {
  const s = new Store();
  s._scheduleSave = () => {};
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  (cards || []).forEach((c) => { s.board.cards[c.id] = c; });
  return s;
}

function card(over) {
  return Object.assign({
    id: 's1',
    project: 'C:\\Sites\\alpha',
    column: 'needs_input',
    lastActiveAt: '2026-10-01T10:00:00.000Z',
    sessionEndedAt: null,
    history: [],
  }, over);
}

test('markSessionEnded stamps the time it is given, not the time it runs', () => {
  const s = fixture([card()]);
  const r = s.markSessionEnded('s1', { at: '2026-10-01T11:00:00.000Z' });
  assert.ok(r);
  assert.strictEqual(r.sessionEndedAt, '2026-10-01T11:00:00.000Z');
  const last = r.history[r.history.length - 1];
  assert.strictEqual(last.kind, 'ended');
  assert.strictEqual(last.at, '2026-10-01T11:00:00.000Z');
});

test('markSessionEnded ignores an end older than the last activity', () => {
  // Marker written at 09:00, session resumed and active at 10:00.
  const s = fixture([card()]);
  assert.strictEqual(s.markSessionEnded('s1', { at: '2026-10-01T09:00:00.000Z' }), null);
  assert.strictEqual(s.board.cards.s1.sessionEndedAt, null);
});

test('markSessionEnded leaves an already-ended card alone', () => {
  const s = fixture([card({ sessionEndedAt: '2026-10-01T11:00:00.000Z' })]);
  assert.strictEqual(s.markSessionEnded('s1'), null);
  assert.strictEqual(s.board.cards.s1.sessionEndedAt, '2026-10-01T11:00:00.000Z');
  assert.strictEqual(s.board.cards.s1.history.length, 0);
});

test('markSessionEnded without a time uses now', () => {
  const s = fixture([card()]);
  const before = Date.now();
  const r = s.markSessionEnded('s1');
  assert.ok(Date.parse(r.sessionEndedAt) >= before);
});

test('markSessionEnded on a missing card is a no-op', () => {
  const s = fixture([]);
  assert.strictEqual(s.markSessionEnded('nope'), null);
});

test('write + drain applies each marker once and removes it', () => {
  const dir = tmpDir();
  const at = hoursAgo(1);
  assert.ok(pendingEnds.write('abc-123', at, dir));
  const seen = [];
  const n = pendingEnds.drain((session, at) => { seen.push([session, at]); return true; }, dir);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(seen, [['abc-123', at]]);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  // A second drain finds nothing.
  assert.strictEqual(pendingEnds.drain(() => true, dir), 0);
});

test('drain consumes a marker even when apply reports no change', () => {
  // No card for the session, or the end was stale: nothing will ever make the
  // marker applicable later, so it must not linger.
  const dir = tmpDir();
  pendingEnds.write('ghost', new Date().toISOString(), dir);
  assert.strictEqual(pendingEnds.drain(() => false, dir), 0);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('drain sets aside a corrupt marker instead of deleting it', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json', 'utf8');
  pendingEnds.drain(() => { throw new Error('must not be called'); }, dir);
  const left = fs.readdirSync(dir);
  assert.strictEqual(left.length, 1);
  assert.ok(left[0].startsWith('bad.json.corrupt-'));
  // ...and a later drain does not trip over it again.
  assert.strictEqual(pendingEnds.drain(() => true, dir), 0);
});

test('drain drops markers past their TTL without applying them', () => {
  const dir = tmpDir();
  const old = new Date(Date.now() - pendingEnds.MARKER_TTL_MS - 60000).toISOString();
  pendingEnds.write('old', old, dir);
  let called = false;
  pendingEnds.drain(() => { called = true; return true; }, dir);
  assert.strictEqual(called, false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('marker paths cannot escape the marker directory', () => {
  const dir = tmpDir();
  const p = pendingEnds.markerPath('../../etc/passwd', dir);
  assert.strictEqual(path.dirname(p), dir);
  assert.strictEqual(pendingEnds.markerPath('', dir), null);
  assert.strictEqual(pendingEnds.write('///', null, dir), false);
});

test('drain with no directory is a quiet zero', () => {
  assert.strictEqual(pendingEnds.drain(() => true, path.join(tmpDir(), 'missing')), 0);
});

test('a drained marker ends the card through the store', () => {
  const dir = tmpDir();
  const s = fixture([card({ lastActiveAt: hoursAgo(3) })]);
  const at = hoursAgo(2);
  pendingEnds.write('s1', at, dir);
  pendingEnds.drain((session, when) => !!s.markSessionEnded(session, { at: when }), dir);
  assert.strictEqual(s.board.cards.s1.sessionEndedAt, at);
});

// ----- who ended it (issue #33) -----

test('markSessionEnded records who ended the session', () => {
  const s = fixture([card({ id: 'a' }), card({ id: 'b' })]);
  s.markSessionEnded('a', { by: 'self' });
  s.markSessionEnded('b');
  assert.strictEqual(s.board.cards.a.endedBy, 'self');
  assert.strictEqual(s.board.cards.a.history.at(-1).text, 'Session marked itself ended');
  assert.strictEqual(s.board.cards.b.endedBy, 'hook');
  assert.strictEqual(s.board.cards.b.history.at(-1).text, 'Session ended');
});

test('an unknown ender falls back to the hook rather than storing junk', () => {
  const s = fixture([card()]);
  s.markSessionEnded('s1', { by: '<script>' });
  assert.strictEqual(s.board.cards.s1.endedBy, 'hook');
});

test('a self-end never moves the card', () => {
  // Ended is not Done (CLAUDE.md constraint 5).
  const s = fixture([card({ column: 'task_completed' })]);
  s.markSessionEnded('s1', { by: 'self' });
  assert.strictEqual(s.board.cards.s1.column, 'task_completed');
});

test('resuming the session clears the end and who ended it', () => {
  const s = fixture([card()]);
  s.markSessionEnded('s1', { by: 'self' });
  s.upsertSession('s1', 'C:\\Sites\\alpha', 'prompt');
  assert.strictEqual(s.board.cards.s1.sessionEndedAt, null);
  assert.strictEqual(s.board.cards.s1.endedBy, null);
});
