'use strict';

// Tests for the two project roll-ups and the bookkeeping-command tag.
//
// All three exist to keep a number on screen honest, which is exactly the kind
// of thing that rots without a test:
//
//   projects().activeCount  the figure in the topbar dropdown's parentheses
//                           when "Show done" is off. Counting done cards there
//                           overstated the work in flight.
//   projectSummary()        the Projects table, which must span the archive as
//                           well as the board or it answers the wrong question.
//   noteSkipCommand()       the /git-review and /git-commit-message tags. Its
//                           two invariants (never create a card, never bump
//                           lastActiveAt) are both easy to break by accident.
//
// A real Store is used, with its debounced save stubbed out and its in-memory
// board replaced by a fixture: the constructor only READS data/board.json, so
// nothing here touches the user's real board.

const test = require('node:test');
const assert = require('node:assert');

const { Store } = require('../lib/store');

const ALPHA = 'C:\\Sites\\alpha';
const BETA = 'C:\\Sites\\beta';

function card(over) {
  return Object.assign({
    id: 'c1',
    project: ALPHA,
    projectLabel: 'alpha',
    repoUrl: null,
    gitBranch: null,
    column: 'working',
    headline: '',
    autoTitle: '',
    model: null,
    skippedBefore: null,
    skipCommands: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    history: [],
  }, over);
}

// A Store whose board/archive are the given fixtures and whose saves are inert.
function fixture(boardCards, archiveCards) {
  const s = new Store();
  s._scheduleSave = () => {};
  s._archiveDirty = false;
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  (boardCards || []).forEach((c) => { s.board.cards[c.id] = c; });
  (archiveCards || []).forEach((c) => { s.archive.cards[c.id] = c; });
  return s;
}

// ---------- projects(): the dropdown counts ----------

test('projects() reports done cards separately from active ones', () => {
  const s = fixture([
    card({ id: 'a', column: 'working' }),
    card({ id: 'b', column: 'done' }),
    card({ id: 'c', column: 'needs_input' }),
  ]);
  const rows = s.projects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3, 'count stays the whole-board total');
  assert.equal(rows[0].activeCount, 2, 'activeCount excludes the done column');
});

test('projects() keeps a project whose cards are all done, at activeCount 0', () => {
  const s = fixture([card({ id: 'a', column: 'done' })]);
  const rows = s.projects();
  assert.equal(rows.length, 1, 'the project must not vanish from the filter');
  assert.equal(rows[0].activeCount, 0);
  assert.equal(rows[0].count, 1);
});

test('projects() ignores cards with no project path', () => {
  const s = fixture([card({ id: 'a', project: '', projectLabel: '' })]);
  assert.equal(s.projects().length, 0);
});

// ---------- projectSummary(): the Projects table ----------

test('projectSummary() spans the board and the archive', () => {
  const s = fixture(
    [card({ id: 'a', column: 'working', lastActiveAt: '2026-08-05T00:00:00.000Z' }),
      card({ id: 'b', column: 'done', lastActiveAt: '2026-08-03T00:00:00.000Z' })],
    [card({ id: 'z', lastActiveAt: '2026-08-01T00:00:00.000Z' })]
  );
  const rows = s.projectSummary();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 3);
  assert.equal(rows[0].active, 1);
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].archived, 1);
  assert.equal(rows[0].lastCard.id, 'a', 'the newest card supplies the row identity');
  assert.equal(rows[0].firstSeenAt, '2026-08-01T00:00:00.000Z');
});

test('projectSummary() folds paths that differ only in case or separator', () => {
  const s = fixture([
    card({ id: 'a', project: ALPHA, lastActiveAt: '2026-08-01T00:00:00.000Z' }),
    card({ id: 'b', project: 'c:/Sites/alpha/', lastActiveAt: '2026-08-09T00:00:00.000Z' }),
  ]);
  const rows = s.projectSummary();
  assert.equal(rows.length, 1, 'one folder, one row');
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].project, 'c:/Sites/alpha/', 'the newest card supplies the spelling');
});

test('projectSummary() keeps a repo URL from an older card when the newest has none', () => {
  const s = fixture([
    card({ id: 'old', repoUrl: 'https://github.com/me/alpha', lastActiveAt: '2026-08-01T00:00:00.000Z' }),
    card({ id: 'new', repoUrl: null, lastActiveAt: '2026-08-09T00:00:00.000Z' }),
  ]);
  const rows = s.projectSummary();
  assert.equal(rows[0].lastCard.id, 'new');
  assert.equal(rows[0].repoUrl, 'https://github.com/me/alpha');
});

test('projectSummary() sorts most-recently-active first', () => {
  const s = fixture([
    card({ id: 'a', project: ALPHA, projectLabel: 'alpha', lastActiveAt: '2026-08-01T00:00:00.000Z' }),
    card({ id: 'b', project: 'C:\\Sites\\beta', projectLabel: 'beta', lastActiveAt: '2026-08-09T00:00:00.000Z' }),
  ]);
  assert.deepEqual(s.projectSummary().map((r) => r.projectLabel), ['beta', 'alpha']);
});

test('projectSummary() counts how many sessions in a project ran each command', () => {
  const s = fixture(
    [card({ id: 'a', skipCommands: { 'git-review': { count: 3 } } }),
      card({ id: 'b', skippedBefore: { count: 1, commands: ['git-review'], firstAt: null } })],
    [card({ id: 'z', skipCommands: { 'git-commit-message': { count: 1 } } })]
  );
  const row = s.projectSummary()[0];
  assert.equal(row.skipCommands['git-review'], 2, 'two sessions ran it, not four times');
  assert.equal(row.skipCommands['git-commit-message'], 1);
});

test('projectSummary() counts a command once for a session recorded in both places', () => {
  const s = fixture([card({
    id: 'a',
    skipCommands: { 'git-review': { count: 2 } },
    skippedBefore: { count: 1, commands: ['git-review'], firstAt: null },
  })]);
  assert.equal(s.projectSummary()[0].skipCommands['git-review'], 1);
});

// ---------- noteSkipCommand(): the card tags ----------

test('noteSkipCommand() records the command and tallies repeats', () => {
  const s = fixture([card({ id: 'a' })]);
  s.noteSkipCommand('a', 'git-review');
  s.noteSkipCommand('a', '/git-review');
  const rec = s.board.cards.a.skipCommands['git-review'];
  assert.equal(rec.count, 2, 'a leading slash must not create a second entry');
  assert.ok(rec.firstAt && rec.lastAt);
});

test('noteSkipCommand() never creates a card', () => {
  const s = fixture([]);
  assert.equal(s.noteSkipCommand('nope', 'git-review'), null);
  assert.deepEqual(Object.keys(s.board.cards), [],
    'a bookkeeping prompt must not put a session on the board');
});

test('noteSkipCommand() does not bump lastActiveAt', () => {
  const s = fixture([card({ id: 'a', lastActiveAt: '2026-08-01T00:00:00.000Z' })]);
  s.noteSkipCommand('a', 'git-review');
  assert.equal(s.board.cards.a.lastActiveAt, '2026-08-01T00:00:00.000Z',
    'drafting a commit message is not the session doing work');
});

test('noteSkipCommand() logs history once per command, not once per run', () => {
  const s = fixture([card({ id: 'a' })]);
  s.noteSkipCommand('a', 'git-review');
  s.noteSkipCommand('a', 'git-review');
  s.noteSkipCommand('a', 'git-commit-message');
  const logged = s.board.cards.a.history.filter((h) => h.kind === 'skipped');
  assert.equal(logged.length, 2);
});

test('noteSkipCommand() ignores an empty command name', () => {
  const s = fixture([card({ id: 'a' })]);
  assert.equal(s.noteSkipCommand('a', '   '), null);
  assert.equal(s.noteSkipCommand('a', '/'), null);
  assert.equal(s.board.cards.a.skipCommands, null);
});

test('noteSkipCommand() rejects a name that is not slash-command shaped', () => {
  const s = fixture([card({ id: 'a' })]);
  assert.equal(s.noteSkipCommand('a', '../../etc/passwd'), null);
  assert.equal(s.noteSkipCommand('a', 'has space'), null);
  assert.equal(s.noteSkipCommand('a', '<script>'), null);
  assert.equal(s.noteSkipCommand('a', 'x'.repeat(200)), null, 'over the 60-char cap');
  assert.equal(s.board.cards.a.skipCommands, null);
  // The real names must still pass.
  assert.ok(s.noteSkipCommand('a', 'git-commit-message'));
  assert.ok(s.noteSkipCommand('a', 'git-review'));
});

// ---------- regressions from the 2026-08-26 review ----------

test('projectSummary() takes repoUrl from the NEWEST card that has one', () => {
  const older = { id: 'old', repoUrl: 'https://github.com/me/old-name', lastActiveAt: '2026-08-01T00:00:00.000Z' };
  const newer = { id: 'new', repoUrl: 'https://github.com/me/new-name', lastActiveAt: '2026-08-09T00:00:00.000Z' };
  // Both insertion orders, because the bug this pins was Object.values() order
  // leaking into the result: first-one-wins gave the OLDEST card's URL, so a
  // renamed repo left the row linking to a dead URL while gitBranch came from
  // the newest card (old-repo/tree/current-branch).
  for (const order of [[older, newer], [newer, older]]) {
    const s = fixture(order.map((o) => card(o)));
    assert.equal(s.projectSummary()[0].repoUrl, 'https://github.com/me/new-name',
      'insertion order must not decide which URL wins');
  }
});

test('projectSummary() still keeps an older URL when the newest card has none', () => {
  const s = fixture([
    card({ id: 'old', repoUrl: 'https://github.com/me/alpha', lastActiveAt: '2026-08-01T00:00:00.000Z' }),
    card({ id: 'new', repoUrl: null, lastActiveAt: '2026-08-09T00:00:00.000Z' }),
  ]);
  assert.equal(s.projectSummary()[0].repoUrl, 'https://github.com/me/alpha',
    'a sub-folder session that never resolved a remote must not blank the link');
});

test('both recording paths accept the same command names', () => {
  // The two paths used to disagree: noteSkipCommand() rejected anything outside
  // [A-Za-z0-9._:-] while noteSkippedBefore() accepted any non-empty string, so
  // whether a command got a tag depended on when in the session it ran.
  const ok = ['git-review', 'plugin:skill', 'frontend/deploy', 'a.b_c', 'x', 'a..b'];
  // 'a/../b' and 'a/./b' matter more than they look: they satisfy every
  // character rule, so only a segment check keeps them out. The obvious
  // '../../etc/passwd' was already caught by "first character must be
  // alphanumeric", which made the charset rule look more complete than it was.
  const bad = ['../../etc/passwd', 'a/../b', 'a/./b', 'a//b', 'has space',
    '<script>', '-leading', 'x'.repeat(61), '', '/'];

  for (const name of ok) {
    const s = fixture([card({ id: 'a' })]);
    assert.ok(s.noteSkipCommand('a', name), 'live path should accept ' + JSON.stringify(name));
    s.noteSkippedBefore('a', { count: 1, commands: [name] });
    assert.deepEqual(s.board.cards.a.skippedBefore.commands, [name],
      'pre-card path should accept ' + JSON.stringify(name));
  }
  for (const name of bad) {
    const s = fixture([card({ id: 'a' })]);
    assert.equal(s.noteSkipCommand('a', name), null, 'live path should reject ' + JSON.stringify(name));
    s.noteSkippedBefore('a', { count: 1, commands: [name] });
    assert.deepEqual(s.board.cards.a.skippedBefore.commands, [],
      'pre-card path should reject ' + JSON.stringify(name));
  }
});

test('noteSkippedBefore() deduplicates before applying the five-name cap', () => {
  // "/git-review" and "git-review" normalize to one name. Left as duplicates
  // they persist, read back as "(/git-review, /git-review)" in the history
  // line, and — the part that loses data — fill the cap so a genuinely
  // different command falls off the end.
  const s = fixture([card({ id: 'a' })]);
  s.noteSkippedBefore('a', { count: 6, commands: ['/a', 'a', '/a', 'a', '/a', 'b'] });
  assert.deepEqual(s.board.cards.a.skippedBefore.commands, ['a', 'b'],
    'duplicates must not evict a real command name');

  const s2 = fixture([card({ id: 'b' })]);
  s2.noteSkippedBefore('b', { count: 2, commands: ['git-review', '/git-review'] });
  const line = s2.board.cards.b.history.find((h) => h.kind === 'skipped').text;
  assert.ok(line.includes('(/git-review)'), 'history should name the command once, got: ' + line);
});

test('projects() and projectSummary() agree on how many distinct folders exist', () => {
  const cards = [
    card({ id: 'a', project: ALPHA, lastActiveAt: '2026-08-01T00:00:00.000Z' }),
    card({ id: 'b', project: 'c:/Sites/alpha/', lastActiveAt: '2026-08-09T00:00:00.000Z' }),
  ];
  const s = fixture(cards);
  assert.equal(s.projects().length, s.projectSummary().length,
    'the topbar filter and the Projects table must not disagree on folder count');
  assert.equal(s.projects()[0].count, 2);
  assert.equal(s.projects()[0].project, 'c:/Sites/alpha/',
    'the newest spelling is offered, matching projectSummary()');
});

test('listCards() filters on the normalized path', () => {
  const s = fixture([
    card({ id: 'a', project: ALPHA }),
    card({ id: 'b', project: 'c:/Sites/alpha/' }),
    card({ id: 'c', project: BETA }),
  ]);
  // A filter value captured under either spelling must still find both cards.
  assert.equal(s.listCards(ALPHA).length, 2);
  assert.equal(s.listCards('c:/Sites/alpha/').length, 2);
  assert.equal(s.listCards(BETA).length, 1);
  assert.equal(s.listCards(null).length, 3);
});

test('counts() reports the totals the view tabs show', () => {
  const s = fixture(
    [card({ id: 'a', column: 'working' }),
      card({ id: 'b', column: 'done' }),
      card({ id: 'c', project: BETA })],
    [card({ id: 'z', project: 'c:/Sites/BETA' })]
  );
  const c = s.counts();
  assert.equal(c.board, 3);
  assert.equal(c.done, 1);
  assert.equal(c.archive, 1);
  assert.equal(c.projects, 2, 'distinct folders across board and archive, normalized');
});
