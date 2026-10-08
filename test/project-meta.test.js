'use strict';

// Tests for project edits: the validation in lib/project-meta.js, and how the
// Store applies a saved edit to the Projects table, the topbar filter, and the
// cards. The edits exist to correct a wrong repo link and to make a project
// findable by a word that is in neither its name nor its path, so each
// surface that renders or searches those values is pinned here.
//
// Same harness as store-projects.test.js: a real Store, saves stubbed, board
// and edits replaced by fixtures, so nothing touches the user's data/ files.

const test = require('node:test');
const assert = require('node:assert');

const { Store } = require('../lib/store');
const { applyPatch, loadEntry, cleanRepoUrl, cleanLinks, cleanKeywords, cleanNote } = require('../lib/project-meta');

const ALPHA = 'C:\\Sites\\alpha';

function card(over) {
  return Object.assign({
    id: 'c1',
    project: ALPHA,
    projectLabel: 'alpha',
    repoUrl: 'https://github.com/owner/wrong',
    gitBranch: 'main',
    column: 'working',
    headline: '',
    autoTitle: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    history: [],
  }, over);
}

function fixture(boardCards, archiveCards) {
  const s = new Store();
  s._scheduleSave = () => {};
  s.board = { version: 1, columns: s.board.columns, cards: {} };
  s.archive = { version: 1, cards: {} };
  s.projectMeta = { version: 1, projects: {} };
  (boardCards || []).forEach((c) => { s.board.cards[c.id] = c; });
  (archiveCards || []).forEach((c) => { s.archive.cards[c.id] = c; });
  return s;
}

// ---------- validation ----------

test('cleanRepoUrl() accepts https and strips .git and a trailing slash', () => {
  assert.deepEqual(cleanRepoUrl('https://github.com/owner/repo.git'), { value: 'https://github.com/owner/repo' });
  assert.deepEqual(cleanRepoUrl(' https://github.com/owner/repo/ '), { value: 'https://github.com/owner/repo' });
});

test('cleanRepoUrl() converts a pasted git remote', () => {
  assert.deepEqual(cleanRepoUrl('git@github.com:owner/repo.git'), { value: 'https://github.com/owner/repo' });
});

test('cleanRepoUrl() refuses schemes that would be unsafe in an href', () => {
  assert.ok(cleanRepoUrl('javascript:alert(1)').error);
  assert.ok(cleanRepoUrl('data:text/html,hi').error);
  assert.ok(cleanRepoUrl('file:///C:/x').error);
});

test('cleanRepoUrl() refuses a link that carries credentials', () => {
  assert.ok(cleanRepoUrl('https://user:token@github.com/owner/repo').error);
});

// A deliberate asymmetry, pinned so it is not "fixed" by accident. An http(s)
// link with a user part is refused: that is where a token actually works. A
// git remote's bare user part is stripped, not refused: an SSH user name is a
// login, not a secret (SSH authenticates with a key), and valid remotes use
// users other than "git" — AWS CodeCommit puts the SSH key ID there, Gitea and
// Forgejo installs use their own. A remote that carries a password does not
// parse at all, so it is refused.
test('cleanRepoUrl() strips a bare SSH user, refuses a remote password', () => {
  assert.deepEqual(cleanRepoUrl('ssh://anyuser@github.com/o/r'), { value: 'https://github.com/o/r' });
  assert.deepEqual(cleanRepoUrl('gitea@git.example.com:o/r.git'), { value: 'https://git.example.com/o/r' });
  assert.deepEqual(
    cleanRepoUrl('ssh://APKAEIBAERJR2EXAMPLE@git-codecommit.us-east-2.amazonaws.com/v1/repos/r'),
    { value: 'https://git-codecommit.us-east-2.amazonaws.com/v1/repos/r' });
  assert.ok(cleanRepoUrl('ssh://user:secret@github.com/o/r').error);
  assert.ok(cleanRepoUrl('user:secret@github.com:o/r').error);
});

test('cleanRepoUrl() treats empty as "clear the override"', () => {
  assert.deepEqual(cleanRepoUrl('   '), { value: null });
});

test('cleanKeywords() splits, trims, and de-duplicates case-insensitively', () => {
  assert.deepEqual(cleanKeywords(' power,  Hibernate , power ,, sleep mode '),
    { value: ['power', 'Hibernate', 'sleep mode'] });
  assert.deepEqual(cleanKeywords(['a', 'A', ' b ']), { value: ['a', 'b'] });
  assert.deepEqual(cleanKeywords(' , '), { value: null });
});

test('cleanKeywords() rejects an over-long keyword and too many keywords', () => {
  assert.ok(cleanKeywords('x'.repeat(41)).error);
  assert.ok(cleanKeywords(Array.from({ length: 21 }, (_, i) => 'k' + i)).error);
});

test('cleanLinks() keeps labeled and unlabeled links, drops empty rows', () => {
  assert.deepEqual(cleanLinks([
    { label: ' Staging ', url: 'https://staging.example.com/x' },
    { label: '', url: '' },
    { url: 'http://localhost:8080' },
  ]), { value: [
    { label: 'Staging', url: 'https://staging.example.com/x' },
    { url: 'http://localhost:8080/' },
  ] });
  assert.deepEqual(cleanLinks([{ label: '', url: ' ' }]), { value: null });
});

test('cleanLinks() names the row in its errors and refuses unsafe links', () => {
  assert.match(cleanLinks([{ url: 'https://a.example' }, { label: 'Docs', url: '' }]).error, /^Link 2 needs a URL/);
  assert.match(cleanLinks([{ url: 'javascript:alert(1)' }]).error, /^Link 1/);
  assert.match(cleanLinks([{ url: 'https://u:p@a.example' }]).error, /token/);
  assert.ok(cleanLinks('https://a.example').error, 'must be a list');
  assert.ok(cleanLinks([{ url: 5 }]).error);
  assert.ok(cleanLinks(Array.from({ length: 11 }, (_, i) => ({ url: 'https://a.example/' + i }))).error);
});

test('cleanNote() keeps line breaks, folds CRLF, and treats blank as none', () => {
  assert.deepEqual(cleanNote('  a  \r\nb\n\n'), { value: 'a\nb' });
  assert.deepEqual(cleanNote(' \n '), { value: null });
  assert.ok(cleanNote('x'.repeat(2001)).error);
});

test('a link that grows when encoded is refused at save, not deleted at load', () => {
  // 225 characters typed, 1225 stored: the check must be on what is stored,
  // or the load-time revalidation refuses what the save accepted.
  const typed = 'https://example.com/wiki/' + 'é'.repeat(200);
  assert.match(cleanLinks([{ url: typed }]).error, /^Link 1 is longer than 500 characters once encoded/);
  assert.match(cleanRepoUrl('https://github.com/o/' + 'é'.repeat(100)).error, /once encoded/);
  // Anything a save accepts, a load accepts unchanged.
  const saved = applyPatch(null, {
    label: 'Alpha', links: [{ label: 'Wiki', url: 'https://example.com/wiki/' + 'é'.repeat(40) }], note: 'n',
  }).meta;
  assert.deepEqual(loadEntry(saved), { meta: saved, dropped: [] });
});

test('loadEntry() drops only the bad field and reports it', () => {
  const r = loadEntry({
    label: 'Keep me',
    repoUrl: 'javascript:alert(1)',
    keywords: ['k'],
    note: 'Keep this too',
    updatedAt: '2026-10-01T00:00:00.000Z',
    junk: 1,
  });
  assert.deepEqual(r.meta, { label: 'Keep me', keywords: ['k'], note: 'Keep this too' });
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0], /^repoUrl: /);
});

test('loadEntry() drops one bad link and keeps the others', () => {
  const r = loadEntry({
    links: [
      { label: 'Good', url: 'https://a.example/' },
      { label: 'Bad', url: 'https://x.example/' + 'a'.repeat(600) },
      { url: 'https://b.example/' },
    ],
  });
  assert.deepEqual(r.meta.links, [{ label: 'Good', url: 'https://a.example/' }, { url: 'https://b.example/' }]);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0], /^links: Link 2 is longer than/, 'reports the link by its real position');
});

test('loadEntry() survives a non-object entry', () => {
  assert.equal(loadEntry('nope').meta, null);
  assert.equal(loadEntry(null).meta, null);
  assert.equal(loadEntry([]).dropped.length, 1);
});

test('applyPatch() changes only the keys sent', () => {
  const r = applyPatch({ label: 'Old', keywords: ['k'] }, { label: 'New' });
  assert.deepEqual(r.meta, { label: 'New', keywords: ['k'] });
});

test('applyPatch() returns null once every override is cleared', () => {
  const r = applyPatch({ label: 'Old' }, { label: '', repoUrl: '', keywords: '' });
  assert.equal(r.meta, null);
});

test('applyPatch() rejects non-text values and drops unknown keys', () => {
  assert.ok(applyPatch(null, { label: 5 }).error);
  assert.ok(applyPatch(null, { label: ['a'] }).error, 'only keywords may be an array');
  assert.deepEqual(applyPatch({ evil: 1 }, { label: 'x' }).meta, { label: 'x' });
});

// ---------- the Store ----------

test('setProjectMeta() refuses a folder no card recorded', () => {
  const s = fixture([card()]);
  const r = s.setProjectMeta('C:\\Sites\\nope', { label: 'x' });
  assert.equal(r.status, 404);
  assert.deepEqual(s.projectMeta.projects, {});
});

test('setProjectMeta() keys by normalized path', () => {
  const s = fixture([card()]);
  s.setProjectMeta('c:/sites/ALPHA/', { label: 'Alpha app' });
  assert.ok(s.projectMeta.projects['c:\\sites\\alpha']);
});

test('projectSummary() applies the override and keeps the detected values', () => {
  const s = fixture([card()]);
  s.setProjectMeta(ALPHA, { repoUrl: 'https://github.com/owner/right', label: 'Alpha app', keywords: 'power' });
  const row = s.projectSummary()[0];
  assert.equal(row.repoUrl, 'https://github.com/owner/right');
  assert.equal(row.detectedRepoUrl, 'https://github.com/owner/wrong');
  assert.equal(row.projectLabel, 'Alpha app');
  assert.equal(row.detectedLabel, 'alpha');
  assert.deepEqual(row.keywords, ['power']);
  assert.deepEqual(row.override, {
    label: 'Alpha app', repoUrl: 'https://github.com/owner/right', links: [], keywords: ['power'], note: '',
  });
});

test('projectSummary() carries other links and the note on the row only', () => {
  const s = fixture([card()]);
  s.setProjectMeta(ALPHA, {
    links: [{ label: 'Staging', url: 'https://staging.example.com' }],
    note: 'Line one\r\nLine two',
  });
  const row = s.projectSummary()[0];
  assert.deepEqual(row.links, [{ label: 'Staging', url: 'https://staging.example.com/' }]);
  assert.equal(row.note, 'Line one\nLine two');
  assert.equal(row.repoUrl, 'https://github.com/owner/wrong', 'other links do not touch the repo link');
  const [c] = s.withProjectMeta(s.listCards(null));
  assert.equal(c.links, undefined, 'cards do not carry project links');
  assert.equal(c.note, undefined, 'cards do not carry the project note');
});

test('projectSummary() without an override reports no keywords and a null override', () => {
  const row = fixture([card()]).projectSummary()[0];
  assert.deepEqual(row.keywords, []);
  assert.equal(row.override, null);
  assert.equal(row.repoUrl, 'https://github.com/owner/wrong');
});

test('projects() carries the label override and keywords for the topbar filter', () => {
  const s = fixture([card()]);
  s.setProjectMeta(ALPHA, { label: 'Alpha app', keywords: ['power'] });
  const row = s.projects()[0];
  assert.equal(row.projectLabel, 'Alpha app');
  assert.deepEqual(row.keywords, ['power']);
});

test('withProjectMeta() decorates copies and leaves stored cards alone', () => {
  const s = fixture([card()], [card({ id: 'old', project: 'c:/sites/alpha' })]);
  s.setProjectMeta(ALPHA, { repoUrl: 'https://github.com/owner/right', keywords: 'power' });
  const [onBoard] = s.withProjectMeta(s.listCards(null));
  const [archived] = s.withProjectMeta(s.listArchive());
  assert.equal(onBoard.repoUrl, 'https://github.com/owner/right');
  assert.equal(archived.repoUrl, 'https://github.com/owner/right', 'other path spelling, same folder');
  assert.deepEqual(onBoard.projectKeywords, ['power']);
  assert.equal(s.board.cards.c1.repoUrl, 'https://github.com/owner/wrong', 'stored card unchanged');
});

test('clearing the repo link falls back to the detected one', () => {
  const s = fixture([card()]);
  s.setProjectMeta(ALPHA, { repoUrl: 'https://github.com/owner/right' });
  s.setProjectMeta(ALPHA, { repoUrl: '' });
  assert.equal(s.projectSummary()[0].repoUrl, 'https://github.com/owner/wrong');
  assert.deepEqual(s.projectMeta.projects, {}, 'an empty record is removed, not kept as {}');
});
