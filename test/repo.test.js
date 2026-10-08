'use strict';

// Tests for issue #29: a card's repository link must follow its folder's git
// remote when the remote changes, instead of keeping the link it saw at
// creation for the life of the server.
//
// Two halves. lib/repo.js is exercised against a REAL throwaway git repository
// in the OS temp dir, because the bug lived in the cache in front of `git`, and
// a stubbed git would test the stub. Store.refreshRepoUrl() uses the same
// fixture harness as the other store suites, so the user's data/ is untouched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = require('../lib/repo');
const { Store } = require('../lib/store');

function git(dir, args) {
  execFileSync('git', ['-C', dir].concat(args), { stdio: 'ignore', windowsHide: true });
}

// A fresh repo with the given origin, removed when the test ends.
function tempRepo(t, origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

test('webUrl() reads the remote and serves it from cache while fresh', (t) => {
  const dir = tempRepo(t, 'git@github.com:owner/first.git');
  assert.equal(repo.webUrl(dir), 'https://github.com/owner/first');
  git(dir, ['remote', 'set-url', 'origin', 'git@github.com:owner/second.git']);
  // Within MAX_AGE_MS the cached answer stands: that is the cache doing its
  // job (one spawn per burst of hooks), not the bug.
  assert.equal(repo.webUrl(dir), 'https://github.com/owner/first');
});

test('webUrl() picks up a changed remote once the cache entry is stale', (t) => {
  const dir = tempRepo(t, 'git@github.com:owner/first.git');
  assert.equal(repo.webUrl(dir, 0), 'https://github.com/owner/first');
  git(dir, ['remote', 'set-url', 'origin', 'git@github.com:owner/second.git']);
  assert.equal(repo.webUrl(dir, 0), 'https://github.com/owner/second',
    'before #29 this returned the first link until the server restarted');
});

test('webUrlAsync() picks up a changed remote once stale, and shares one read', async (t) => {
  const dir = tempRepo(t, 'https://github.com/owner/first.git');
  assert.equal(await repo.webUrlAsync(dir, 0), 'https://github.com/owner/first');
  git(dir, ['remote', 'set-url', 'origin', 'https://github.com/owner/second.git']);
  const a = repo.webUrlAsync(dir, 0);
  const b = repo.webUrlAsync(dir, 0);
  assert.strictEqual(a, b, 'concurrent stale reads share one in-flight git spawn');
  assert.equal(await a, 'https://github.com/owner/second');
});

test('webUrl() returns null for a folder with no origin', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  assert.equal(repo.webUrl(dir, 0), null);
});

// ---------- Store.refreshRepoUrl ----------

function fixture(cards) {
  const s = new Store();
  s._scheduleSave = () => {};
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  s.projectMeta = { version: 1, projects: {} };
  cards.forEach((c) => { s.board.cards[c.id] = c; });
  return s;
}

function card(over) {
  return Object.assign({
    id: 'old',
    project: 'C:\\Sites\\alpha',
    projectLabel: 'alpha',
    repoUrl: 'https://github.com/owner/wrong',
    column: 'working',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    history: [],
  }, over);
}

test('refreshRepoUrl() replaces a changed link without touching activity', () => {
  const s = fixture([card()]);
  const before = s.board.cards.old.lastActiveAt;
  assert.ok(s.refreshRepoUrl('old', 'https://github.com/owner/right'));
  assert.equal(s.board.cards.old.repoUrl, 'https://github.com/owner/right');
  assert.equal(s.board.cards.old.lastActiveAt, before, 'a link refresh must not reorder the board');
  assert.equal(s.board.cards.old.history.length, 0, 'no history noise');
});

test('refreshRepoUrl() fills an empty link', () => {
  const s = fixture([card({ repoUrl: null })]);
  assert.ok(s.refreshRepoUrl('old', 'https://github.com/owner/right'));
  assert.equal(s.board.cards.old.repoUrl, 'https://github.com/owner/right');
});

test('refreshRepoUrl() never clears a link when git gave nothing', () => {
  const s = fixture([card()]);
  assert.equal(s.refreshRepoUrl('old', null), null);
  assert.equal(s.board.cards.old.repoUrl, 'https://github.com/owner/wrong');
});

test('refreshRepoUrl() reports no change for the same link or a missing card', () => {
  const s = fixture([card()]);
  assert.equal(s.refreshRepoUrl('old', 'https://github.com/owner/wrong'), null);
  assert.equal(s.refreshRepoUrl('nope', 'https://github.com/owner/right'), null);
});

test('after a refresh, the Projects row stops showing the out-of-date link', () => {
  // The #29 shape: an older card with the wrong link is the most recently
  // active one, so the row used to take its link.
  const s = fixture([
    card({ id: 'old', lastActiveAt: '2026-08-05T00:00:00.000Z' }),
    card({ id: 'new', repoUrl: 'https://github.com/owner/right', lastActiveAt: '2026-08-02T00:00:00.000Z' }),
  ]);
  assert.equal(s.projectSummary()[0].repoUrl, 'https://github.com/owner/wrong', 'the bug, reproduced');
  s.refreshRepoUrl('old', 'https://github.com/owner/right');
  assert.equal(s.projectSummary()[0].repoUrl, 'https://github.com/owner/right');
});
