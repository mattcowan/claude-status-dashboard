'use strict';

// Tests for Store.bulk() — the board's selection bar (issue #34).
//
// What it must get right is the honest report: which ids changed, which were
// already in the requested state, and which were not on the board at all, so
// the UI never claims "archived 5" when two had already gone. And it must not
// act on anything that is not an own key of board.cards (the "__proto__"
// lookup), since the ids come straight from a request body.
//
// Same pattern as store-projects.test.js: a real Store, saves stubbed, board
// replaced by a fixture. Nothing touches data/.

const test = require('node:test');
const assert = require('node:assert');

const { Store, MAX_BULK } = require('../lib/store');

function card(id, over) {
  return Object.assign({
    id: id,
    project: 'C:\\Sites\\alpha',
    column: 'needs_input',
    lastActiveAt: '2026-10-01T10:00:00.000Z',
    sessionEndedAt: null,
    history: [],
  }, over);
}

function fixture(cards) {
  const s = new Store();
  s._scheduleSave = () => {};
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  (cards || []).forEach((c) => { s.board.cards[c.id] = c; });
  return s;
}

test('end marks each card ended by the user and reports the rest', () => {
  const s = fixture([card('a'), card('b', { sessionEndedAt: '2026-10-01T11:00:00.000Z', endedBy: 'hook' })]);
  const r = s.bulk(['a', 'b', 'gone'], 'end');
  assert.deepStrictEqual(r.changed, ['a']);
  assert.deepStrictEqual(r.unchanged, ['b']);
  assert.deepStrictEqual(r.missing, ['gone']);
  assert.strictEqual(s.board.cards.a.endedBy, 'user');
  assert.strictEqual(s.board.cards.a.history.at(-1).text, 'Marked ended from the dashboard');
  // The already-ended card keeps who really ended it.
  assert.strictEqual(s.board.cards.b.endedBy, 'hook');
  // Ending never moves a card.
  assert.strictEqual(s.board.cards.a.column, 'needs_input');
});

test('archive moves cards off the board and into the archive', () => {
  const s = fixture([card('a'), card('b')]);
  const r = s.bulk(['a', 'b'], 'archive');
  assert.deepStrictEqual(r.changed, ['a', 'b']);
  assert.deepStrictEqual(Object.keys(s.board.cards), []);
  assert.deepStrictEqual(Object.keys(s.archive.cards).sort(), ['a', 'b']);
  assert.strictEqual(s.archive.cards.a.archivedFrom, 'needs_input');
});

test('move changes column, and a card already there is unchanged', () => {
  const s = fixture([card('a'), card('b', { column: 'working' })]);
  const r = s.bulk(['a', 'b'], 'move', 'working');
  assert.deepStrictEqual(r.changed, ['a']);
  assert.deepStrictEqual(r.unchanged, ['b']);
  assert.strictEqual(r.column, 'working');
  assert.strictEqual(s.board.cards.a.column, 'working');
});

test('move to Done is allowed — the user is acting', () => {
  const s = fixture([card('a')]);
  assert.deepStrictEqual(s.bulk(['a'], 'move', 'done').changed, ['a']);
  assert.strictEqual(s.board.cards.a.column, 'done');
});

test('archived cards count as missing', () => {
  const s = fixture([card('a')]);
  s.archive.cards.z = card('z');
  const r = s.bulk(['z'], 'end');
  assert.deepStrictEqual(r.missing, ['z']);
  assert.strictEqual(s.archive.cards.z.sessionEndedAt, null);
});

test('prototype keys are never treated as cards', () => {
  const s = fixture([card('a')]);
  const r = s.bulk(['__proto__', 'constructor', 'toString'], 'end');
  assert.deepStrictEqual(r.missing, ['__proto__', 'constructor', 'toString']);
  assert.strictEqual({}.sessionEndedAt, undefined);
});

test('duplicate and non-string ids are dropped before acting', () => {
  const s = fixture([card('a')]);
  const r = s.bulk(['a', 'a', 7, null, ''], 'end');
  assert.deepStrictEqual(r.changed, ['a']);
  assert.deepStrictEqual(r.unchanged, []);
});

test('bad requests are refused with nothing changed', () => {
  const s = fixture([card('a')]);
  assert.strictEqual(s.bulk('a', 'end').status, 400);
  assert.strictEqual(s.bulk([], 'end').status, 400);
  assert.strictEqual(s.bulk(['a'], 'delete').status, 400);
  assert.strictEqual(s.bulk(['a'], 'move', 'nope').status, 400);
  assert.strictEqual(s.bulk(['a'], 'move').status, 400);
  const many = Array.from({ length: MAX_BULK + 1 }, (_, i) => 'id' + i);
  assert.strictEqual(s.bulk(many, 'end').status, 400);
  assert.strictEqual(s.board.cards.a.sessionEndedAt, null);
  assert.strictEqual(s.board.cards.a.column, 'needs_input');
});
