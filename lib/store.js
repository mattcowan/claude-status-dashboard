'use strict';

// In-memory board with a debounced, atomic on-disk save.
// The server is a single long-lived process, so all mutations funnel through
// this one module in one event loop -> no cross-process write races even when
// many Claude sessions post concurrently.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');

// The three "root" columns Claude uses, plus the special "done" column (always
// last, hidden by default, archive semantics). Users may add custom columns in
// between and reorder freely; Claude only ever targets the three roots.
const DEFAULT_COLUMNS = [
  { key: 'working', label: 'Working', kind: 'root', color: '#4c8dff' },
  { key: 'needs_input', label: 'Needs Input', kind: 'root', color: '#f5a623' },
  { key: 'task_completed', label: 'Ready for Review', kind: 'root', color: '#35c46b' },
  { key: 'done', label: 'Done', kind: 'done', color: '#6b7480' },
];

// Palette used to auto-assign colors to user-created columns.
const CUSTOM_PALETTE = [
  '#a06bff', '#24b8c4', '#e0609a', '#7c9cff',
  '#38b000', '#ff8c42', '#c65cff', '#00b3a4',
];

function nowIso() {
  return new Date().toISOString();
}

// The skip-listed bookkeeping commands (see lib/skip-prompts.js) recorded
// against a card, as a deduplicated set of names sorted so the UI renders the
// tags in a stable order.
//
// Two sources feed it and both matter:
//   skippedBefore.commands — runs from BEFORE the card existed, captured by the
//     marker file and handed over on the POST that finally minted the card.
//   skipCommands           — runs on an established card, reported live by the
//     UserPromptSubmit hook (noteSkipCommand below).
// A session that ran /git-review first and again later appears in both, so the
// union is what "this command was run on this session" actually means.
// Normalize a skip-listed command name for storage, or return '' to reject it.
//
// Both paths that record a command go through this — noteSkipCommand (a run on
// an established card) and noteSkippedBefore (runs from before the card
// existed) — because a name that works on one path and is silently dropped on
// the other is worse than either rule on its own: whether your command gets a
// tag would depend on when in the session you ran it.
//
// The charset is deliberately wider than a bare identifier. Slash commands
// really do carry ':' (plugin:skill), '/' (a directory-scoped skill such as
// frontend/deploy), '.' and '-', and lib/skip-prompts.js will happily match any
// of them. What is rejected is what is not a command name at all: whitespace,
// path traversal, markup, and anything long enough to be a paste rather than a
// name. These become persisted object keys and on-screen tags, so the rule is
// about keeping junk out of board.json, not about guessing the skill registry.
const MAX_COMMAND_NAME = 60;
const COMMAND_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;

function normalizeCommandName(raw) {
  const name = String(raw == null ? '' : raw).trim().replace(/^[/]+/, '');
  // Rejected, not truncated: a 200-character "command" is not a slash command
  // that got long, it is a caller sending something else, and quietly filing
  // its first 60 characters as a tag would be worse than dropping it.
  if (!name || name.length > MAX_COMMAND_NAME) return '';
  return COMMAND_NAME_SHAPE.test(name) ? name : '';
}

function skipCommandNames(card) {
  const names = new Set();
  if (card && card.skippedBefore && Array.isArray(card.skippedBefore.commands)) {
    for (const n of card.skippedBefore.commands) if (n) names.add(n);
  }
  if (card && card.skipCommands) {
    for (const n of Object.keys(card.skipCommands)) if (n) names.add(n);
  }
  return Array.from(names).sort();
}

// Line prepended to a card body when old note bullets have been dropped.
const TRIM_MARKER = '- … (older notes trimmed)';

// The human's personal note is rendered in full on collapsed cards, so bound it
// server-side: an accidental paste of a whole transcript would otherwise stretch
// one card down the length of its column. The UI caps input at the same figure.
const MAX_USER_NOTE = 500;

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'col';
}

// Folder names that are too generic to identify a project on their own.
const GENERIC_SEGMENTS = new Set([
  'public', 'app', 'src', 'dist', 'build', 'htdocs', 'public_html',
  'www', 'wp-content', 'html', 'out', 'target', 'web', 'site',
]);

// Produce a human-friendly project label: the nearest meaningful path segment.
// e.g. C:\Users\me\Sites\acme-storefront\app\public   -> "acme-storefront"
//      /home/me/code/wp-content/plugins/my-plugin      -> "my-plugin"
function friendlyLabel(project) {
  if (!project) return '(unknown)';
  const segs = String(project).split(/[/\\]+/).filter(Boolean);
  // Drop a Windows drive segment like "C:".
  if (segs.length && /^[a-z]:$/i.test(segs[0])) segs.shift();
  for (let i = segs.length - 1; i >= 0; i--) {
    if (!GENERIC_SEGMENTS.has(segs[i].toLowerCase())) return segs[i];
  }
  return segs[segs.length - 1] || '(unknown)';
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file: back it up so we don't lose it, then start clean.
    try {
      const bak = file + '.corrupt-' + Date.now();
      fs.renameSync(file, bak);
      // eslint-disable-next-line no-console
      console.error('[store] Corrupt ' + path.basename(file) + ' backed up to ' + bak + ': ' + err.message);
    } catch (_) { /* ignore */ }
    return fallback;
  }
}

function atomicWrite(file, obj) {
  ensureDataDir();
  const json = JSON.stringify(obj, null, 2);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows: rename over a file another process has open (editor, indexer,
    // sync client) fails with EPERM. Fall back to an in-place write — not
    // atomic, but losing atomicity once beats losing the save entirely.
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    fs.writeFileSync(file, json, 'utf8');
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

class Store extends EventEmitter {
  constructor() {
    super();
    ensureDataDir();
    const loaded = readJsonSafe(BOARD_FILE, null);
    this.board = loaded && loaded.cards ? loaded : { version: 1, cards: {} };
    if (!this.board.cards) this.board.cards = {};
    // Migrate boards created before custom columns existed.
    if (!Array.isArray(this.board.columns) || !this.board.columns.length) {
      this.board.columns = DEFAULT_COLUMNS.map((c) => Object.assign({}, c));
    } else {
      // Reconcile the fixed (root/done) columns with the canonical defaults so
      // label/color changes here propagate to existing boards. Custom columns
      // and the user's chosen ORDER are left untouched.
      for (const def of DEFAULT_COLUMNS) {
        const existing = this.board.columns.find((c) => c.key === def.key);
        if (existing) {
          existing.label = def.label;
          existing.color = def.color;
          existing.kind = def.kind;
        } else {
          const doneIdx = this.board.columns.findIndex((c) => c.kind === 'done');
          const at = doneIdx === -1 ? this.board.columns.length : doneIdx;
          this.board.columns.splice(at, 0, Object.assign({}, def));
        }
      }
    }
    const arch = readJsonSafe(ARCHIVE_FILE, null);
    this.archive = arch && arch.cards ? arch : { version: 1, cards: {} };
    if (!this.archive.cards) this.archive.cards = {};

    this._saveTimer = null;
    this._archiveDirty = false;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        atomicWrite(BOARD_FILE, this.board);
        if (this._archiveDirty) {
          atomicWrite(ARCHIVE_FILE, this.archive);
          this._archiveDirty = false;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[store] save failed: ' + err.message);
      }
      // One event per debounced save — listeners (SSE) get coalesced bursts.
      this.emit('change');
    }, 120);
    // Do not keep the process alive solely for a pending save.
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  // True when a debounced save is still pending (i.e. memory is ahead of disk).
  hasPendingSave() {
    return !!this._saveTimer;
  }

  // Flush synchronously (used on shutdown).
  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    atomicWrite(BOARD_FILE, this.board);
    if (this._archiveDirty) {
      atomicWrite(ARCHIVE_FILE, this.archive);
      this._archiveDirty = false;
    }
    this.emit('change');
  }

  // Append a timestamped entry to a card's activity history.
  // kind: 'created' | 'status' | 'update' | 'external' | 'ended' | 'archived' | 'model'
  _log(card, kind, text, auto) {
    if (!Array.isArray(card.history)) card.history = [];
    card.history.push({ at: nowIso(), kind: kind, text: text, auto: !!auto });
  }

  // ----- reads -----

  // The project filter compares normalized paths, so a folder recorded twice
  // with a different drive-letter case or slash direction is one project here,
  // in projects() and in projectSummary() alike. Without this the topbar filter
  // and the Projects table disagreed about how many distinct folders exist.
  listCards(projectFilter) {
    const cards = Object.values(this.board.cards);
    const wanted = projectFilter ? normalizePath(projectFilter) : '';
    const filtered = wanted
      ? cards.filter((c) => normalizePath(c.project) === wanted)
      : cards;
    // Newest activity first.
    filtered.sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)));
    return filtered;
  }

  listArchive() {
    const cards = Object.values(this.archive.cards);
    cards.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
    return cards;
  }

  // Board-only project roll-up, for the topbar filter. `count` is every card on
  // the board; `activeCount` excludes the Done column, so the dropdown can show
  // the figure that matches what the board is actually displaying (Done is
  // hidden unless "Show done" is ticked). Projects whose cards are all done
  // stay listed at (0) rather than disappearing — the filter must not lose an
  // entry the moment its last card is finished, or ticking "Show done" would
  // leave nothing to select.
  projects() {
    const map = new Map();
    for (const c of Object.values(this.board.cards)) {
      if (!c.project) continue;
      const key = normalizePath(c.project);
      if (!key) continue;
      const entry = map.get(key) ||
        { project: c.project, projectLabel: c.projectLabel, count: 0, activeCount: 0,
          _at: '' };
      entry.count += 1;
      if (c.column !== 'done') entry.activeCount += 1;
      // The most recently active card supplies the spelling of the path (the
      // option's value) and the label, matching projectSummary(). listCards()
      // compares normalized, so a filter selected under the old spelling keeps
      // working if that flips.
      const at = c.lastActiveAt || c.createdAt || '';
      if (String(at) >= entry._at) {
        entry._at = String(at);
        entry.project = c.project;
        entry.projectLabel = c.projectLabel;
      }
      map.set(key, entry);
    }
    for (const entry of map.values()) delete entry._at;
    return Array.from(map.values()).sort((a, b) =>
      String(a.projectLabel).localeCompare(String(b.projectLabel)));
  }

  // One row per project across BOTH the board and the archive, for the
  // Projects view. Unlike projects() above this is a whole-history read: that
  // view answers "what have I worked on, and when did I last touch it", which
  // a board-only roll-up cannot do once cards have been archived.
  //
  // Rows are keyed by normalized path, so two cards that recorded the same
  // folder with a different drive-letter case or slash direction fold into one
  // row.
  projectSummary() {
    const map = new Map();
    // When each row's repoUrl was recorded, kept beside the row rather than on
    // it so it doesn't ship in the JSON payload.
    const repoAt = new Map();

    const add = (c, archived) => {
      if (!c.project) return;
      const key = normalizePath(c.project);
      if (!key) return;
      let row = map.get(key);
      if (!row) {
        row = {
          project: c.project,
          projectLabel: c.projectLabel || friendlyLabel(c.project),
          repoUrl: null,
          gitBranch: null,
          total: 0, active: 0, done: 0, archived: 0,
          skipCommands: {},
          firstSeenAt: null,
          lastActiveAt: null,
          lastCard: null,
        };
        map.set(key, row);
      }

      row.total += 1;
      if (archived) row.archived += 1;
      else if (c.column === 'done') row.done += 1;
      else row.active += 1;

      for (const name of skipCommandNames(c)) {
        row.skipCommands[name] = (row.skipCommands[name] || 0) + 1;
      }

      const created = c.createdAt || c.lastActiveAt;
      if (created && (!row.firstSeenAt || String(created) < row.firstSeenAt)) {
        row.firstSeenAt = created;
      }

      const at = c.lastActiveAt || c.createdAt || '';
      if (!row.lastActiveAt || String(at) > String(row.lastActiveAt)) {
        row.lastActiveAt = at;
        // The newest card supplies the row's identity too: the spelling of the
        // path whose folder actions the UI offers, the branch, and the headline
        // shown in the "last session" cell. Anything older is stale by
        // definition.
        row.project = c.project;
        row.projectLabel = c.projectLabel || friendlyLabel(c.project);
        row.gitBranch = c.gitBranch || null;
        row.lastCard = {
          id: c.id,
          headline: c.headline || '',
          autoTitle: c.autoTitle || '',
          column: archived ? null : c.column,
          archived: !!archived,
          model: c.model || null,
          lastActiveAt: at,
        };
      }
      // repoUrl comes from the newest card that HAS one, not simply from the
      // newest card: a session opened in a sub-folder may never have resolved a
      // remote, and blanking the row over that would drop a working link.
      //
      // It needs its own high-water mark rather than a first-one-wins check.
      // Object.values() hands cards back in insertion order, so "first with a
      // URL" means the OLDEST card, which is the wrong end: after a repo is
      // renamed or transferred the row would link to the dead URL while
      // gitBranch came from the newest card, producing old-repo/tree/branch.
      if (c.repoUrl && String(at) >= String(repoAt.get(key) || '')) {
        row.repoUrl = c.repoUrl;
        repoAt.set(key, at);
      }
    };

    for (const c of Object.values(this.board.cards)) add(c, false);
    for (const c of Object.values(this.archive.cards)) add(c, true);

    return Array.from(map.values()).sort((a, b) =>
      String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)));
  }

  // Totals for the view tabs. Cheap enough to ride along on every board fetch
  // (one pass over each store), which keeps the Archive and Projects counts
  // live without the board having to fetch either of those views.
  counts() {
    const folders = new Set();
    let done = 0;
    for (const c of Object.values(this.board.cards)) {
      if (c.column === 'done') done += 1;
      const key = normalizePath(c.project);
      if (key) folders.add(key);
    }
    for (const c of Object.values(this.archive.cards)) {
      const key = normalizePath(c.project);
      if (key) folders.add(key);
    }
    return {
      board: Object.keys(this.board.cards).length,
      done: done,
      archive: Object.keys(this.archive.cards).length,
      projects: folders.size,
    };
  }

  getCard(id) {
    return this.board.cards[id] || null;
  }

  // Look a card up on the board or in the archive (read-only helpers like the
  // plan viewer work on both).
  getCardAnywhere(id) {
    return this.board.cards[id] || this.archive.cards[id] || null;
  }

  // Resolve the most-recently-active, non-done card for a given project path.
  // Used by the CLI when Claude does not pass an explicit --session.
  resolveByProject(projectPath) {
    const norm = normalizePath(projectPath);
    const candidates = Object.values(this.board.cards)
      .filter((c) => normalizePath(c.project) === norm && c.column !== 'done')
      .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)));
    return candidates[0] || null;
  }

  // ----- writes -----

  upsertSession(id, project, source, repoUrl, model) {
    let card = this.board.cards[id];
    const now = nowIso();
    if (!card) {
      card = {
        id: id,
        project: project || '',
        projectLabel: friendlyLabel(project),
        repoUrl: repoUrl || null,
        model: null,
        column: 'working',
        headline: '',
        body: '',
        // Written only from the dashboard UI — deliberately not exposed through
        // bin/status.js, so a session's own status writes can never clobber it.
        userNote: '',
        userNoteAt: null,
        leftOff: null,
        autoTitle: null,
        slug: null,
        gitBranch: null,
        transcriptPath: null,
        autoMoved: false,
        // Set only by noteSkippedBefore, at creation time: this session ran
        // skip-listed bookkeeping commands before its first real prompt.
        skippedBefore: null,
        // { '<command>': { count, firstAt, lastAt } } for skip-listed commands
        // run DURING this session, once its card already existed. Populated by
        // noteSkipCommand; see skipCommandNames() for how it combines with
        // skippedBefore.
        skipCommands: null,
        externalEdits: [],
        source: source || 'startup',
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        sessionEndedAt: null,
        archivedAt: null,
        history: [{ at: now, kind: 'created', text: 'Session started in Working', auto: false }],
      };
      this.board.cards[id] = card;
    } else {
      // Session resumed: reactivate but keep its existing content/column.
      card.lastActiveAt = now;
      card.sessionEndedAt = null;
      if (project && !card.project) {
        card.project = project;
        card.projectLabel = friendlyLabel(project);
      }
      if (repoUrl && !card.repoUrl) card.repoUrl = repoUrl;
    }
    // Record/refresh the model (logs first-observation and any switch). Defer
    // its save to the single _scheduleSave() below so a model-bearing upsert
    // only schedules once.
    if (model) this.setModel(id, model, true);
    this._scheduleSave();
    return card;
  }

  // Flag a card whose session ran skip-listed bookkeeping commands (e.g.
  // /git-commit-message — see lib/skip-prompts.js) BEFORE it did any real work.
  // Those turns deliberately create no card, so without this the card's
  // createdAt would quietly understate when the session actually began. Only
  // ever called on the POST that creates the card: a mid-session skip on an
  // established card is normal and gets no flag.
  noteSkippedBefore(id, info) {
    const card = this.board.cards[id];
    if (!card || !info) return null;
    const n = Math.floor(Number(info.count));
    const count = n > 0 ? n : 1;
    const commands = Array.isArray(info.commands)
      ? info.commands.map(normalizeCommandName).filter(Boolean).slice(0, 5)
      : [];
    card.skippedBefore = {
      count: count,
      commands: commands,
      firstAt: typeof info.firstAt === 'string' ? info.firstAt : null,
    };
    const what = commands.length ? commands.map((c) => '/' + c).join(', ') : 'a skipped command';
    this._log(card, 'skipped',
      'Card created late — ' + count + (count === 1 ? ' earlier turn' : ' earlier turns') +
      ' skipped (' + what + ')');
    this._scheduleSave();
    return card;
  }

  // Record that a skip-listed bookkeeping command (/git-review,
  // /git-commit-message — see lib/skip-prompts.js) ran on an EXISTING card, so
  // the board can tag the sessions those commands were used on.
  //
  // Deliberately never creates a card: those prompts are exactly the ones that
  // must not mint one, and the hook only reports them when a card is already
  // there. A missing card is therefore the normal case, not an error.
  //
  // lastActiveAt is left alone for the same reason setModel() leaves it alone:
  // running a commit-message helper is not the session doing work, and bumping
  // the clock would reorder the board and strip the 💤 badge off a session that
  // really has gone quiet. Only the first run of a given command logs to
  // history — a session that drafts six commit messages should not bury its own
  // activity log.
  noteSkipCommand(id, command) {
    const card = this.board.cards[id];
    if (!card) return null;
    // The hook only ever sends a name off the skip list, but the endpoint is
    // reachable by anything on loopback and the name becomes a persisted key,
    // so it is held to the same shape as the pre-card path (see
    // normalizeCommandName). Callers can tell a rejected name from a missing
    // card: this returns null for both, but the endpoint reports which.
    const name = normalizeCommandName(command);
    if (!name) return null;
    const now = nowIso();
    if (!card.skipCommands) card.skipCommands = {};
    const prev = card.skipCommands[name];
    if (prev) {
      prev.count = (Number(prev.count) || 0) + 1;
      prev.lastAt = now;
    } else {
      card.skipCommands[name] = { count: 1, firstAt: now, lastAt: now };
      this._log(card, 'skipped', 'Ran /' + name);
    }
    this._scheduleSave();
    return card;
  }

  // Record the Claude model in use for a session. No-op unless the model is a
  // non-empty string that differs from what's stored. Logs first observation
  // and every switch to the card's history. Does NOT bump lastActiveAt — a
  // model reading shouldn't reorder the board. Pass deferSave=true when called
  // as part of a larger write that schedules the save itself.
  setModel(id, model, deferSave) {
    const card = this.board.cards[id];
    if (!card || typeof model !== 'string' || !model) return null;
    if (card.model === model) return card;
    const prev = card.model;
    this._log(card, 'model', prev ? 'Model: ' + prev + ' → ' + model : 'Model: ' + model);
    card.model = model;
    if (!deferSave) this._scheduleSave();
    return card;
  }

  // Backfill a card's repoUrl (used by the async startup backfill). Only sets
  // when empty; no history entry and no lastActiveAt bump — a link backfill
  // shouldn't reorder the board.
  setRepoUrl(id, url) {
    const card = this.board.cards[id];
    if (!card || !url || card.repoUrl) return null;
    card.repoUrl = url;
    this._scheduleSave();
    return card;
  }

  // Record session metadata pulled from the transcript (auto title, slug,
  // git branch, transcript path). Empty/absent values never clobber stored
  // ones, but a changed non-empty value (e.g. an updated ai-title) overwrites.
  // Quiet on purpose: no history entry, no lastActiveAt bump.
  setSessionMeta(id, meta) {
    const card = this.board.cards[id];
    if (!card || !meta) return null;
    const pairs = [
      ['autoTitle', meta.aiTitle],
      ['slug', meta.slug],
      ['gitBranch', meta.gitBranch],
      ['transcriptPath', meta.transcriptPath],
    ];
    let changed = false;
    for (const [field, value] of pairs) {
      if (typeof value === 'string' && value && card[field] !== value) {
        card[field] = value;
        changed = true;
      }
    }
    if (changed) this._scheduleSave();
    return card;
  }

  // Keep note-append growth bounded: drop the oldest lines once the body
  // exceeds the caps, leaving a trim marker. Only applied on appendBullet —
  // an explicitly authored body (set --body) is stored as given.
  _capBody(card) {
    const MAX_LINES = 60;
    const MAX_CHARS = 4000;
    const lines = String(card.body || '').split('\n');
    const originalCount = lines.length;
    // Drop a previous trim marker before re-trimming so markers don't stack.
    if (lines.length && lines[0] === TRIM_MARKER) lines.shift();
    let trimmed = originalCount > lines.length; // had a marker already
    // Track the joined length as we shift so the loop stays O(n) rather than
    // re-joining the whole body each iteration (matters when the body starts
    // large — e.g. an explicit set --body followed by a note).
    let len = lines.reduce((sum, l) => sum + l.length, 0) + Math.max(0, lines.length - 1);
    while (lines.length > 1 && (lines.length > MAX_LINES || len > MAX_CHARS)) {
      const dropped = lines.shift();
      len -= dropped.length + 1; // the line plus its preceding/trailing newline
      trimmed = true;
    }
    if (trimmed) lines.unshift(TRIM_MARKER);
    card.body = lines.join('\n');
  }

  updateCard(id, fields) {
    const card = this.board.cards[id];
    if (!card) return null;
    const now = nowIso();

    let contentChanged = false;
    if (typeof fields.headline === 'string' && fields.headline !== card.headline) { card.headline = fields.headline; contentChanged = true; }
    if (typeof fields.body === 'string' && fields.body !== card.body) { card.body = fields.body; contentChanged = true; }

    // The personal note is the human's own field, so it stays out of the
    // headline/body content flow entirely: it never clears autoMoved, and a
    // note-only edit must not register as session activity (see the end of this
    // method) or jotting a reminder would strip the 💤 badge off a session that
    // has actually been idle for hours.
    // Requires userNote to actually be present, so an empty or unrelated update
    // keeps its existing activity-bumping behaviour untouched.
    const noteOnly = typeof fields.userNote === 'string' &&
      Object.keys(fields).every((k) => k === 'userNote');
    let noteChanged = false;
    if (typeof fields.userNote === 'string') {
      const note = fields.userNote.trim().slice(0, MAX_USER_NOTE);
      if (note !== (card.userNote || '')) {
        card.userNote = note;
        card.userNoteAt = note ? now : null;
        this._log(card, 'note', note ? 'Personal note updated' : 'Personal note cleared');
        noteChanged = true;
      }
    }

    // Opening the editor and pressing Save without typing is a no-op, so return
    // before _scheduleSave(): that would write the board to disk and emit the
    // 'change' event, making every open tab refetch for nothing. Safe to return
    // here because noteOnly means there is no other field left to apply.
    if (noteOnly && !noteChanged) return card;

    let bulletAdded = false;
    if (typeof fields.appendBullet === 'string' && fields.appendBullet.trim()) {
      const bullet = '- ' + fields.appendBullet.trim();
      card.body = card.body && card.body.trim() ? card.body.replace(/\s+$/, '') + '\n' + bullet : bullet;
      this._capBody(card);
      bulletAdded = true;
    }

    if (fields.column && this.validColumn(fields.column) && fields.column !== card.column) {
      this._log(card, 'status', this.columnLabel(card.column) + ' → ' + this.columnLabel(fields.column), !!fields.auto);
      card.column = fields.column;
    } else if (bulletAdded) {
      this._log(card, 'update', 'Added a note');
    } else if (contentChanged) {
      this._log(card, 'update', 'Updated the headline/description');
    }

    // Any explicit Claude/UI action clears the "auto-moved" flag unless this
    // very update is itself the backstop.
    if ('auto' in fields) {
      card.autoMoved = !!fields.auto;
    } else if (fields.column || typeof fields.headline === 'string' ||
               typeof fields.body === 'string' || typeof fields.appendBullet === 'string') {
      card.autoMoved = false;
    }

    if (fields.leftOff) card.leftOff = fields.leftOff;

    // A note-only edit leaves the activity clock untouched: staleness tracks the
    // session, not the human annotating it. The note carries its own userNoteAt.
    if (!noteOnly) {
      card.updatedAt = now;
      card.lastActiveAt = now;
    }
    this._scheduleSave();
    return card;
  }

  addExternalEdit(id, filePath) {
    const card = this.board.cards[id];
    if (!card || !filePath) return null;
    if (!Array.isArray(card.externalEdits)) card.externalEdits = [];
    if (!card.externalEdits.includes(filePath)) {
      card.externalEdits.push(filePath);
      this._log(card, 'external', 'Edited outside project: ' + filePath);
    }
    card.lastActiveAt = nowIso();
    this._scheduleSave();
    return card;
  }

  // Stop-hook backstop. Only acts when Claude left the card in "working" (i.e.
  // it did NOT deliberately declare needs-input or done-for-review this turn):
  // captures where it left off and moves it to Needs Input, flagged auto. If
  // Claude already set an outcome, we leave its content untouched.
  applyStopBackstop(id, leftOffText) {
    const card = this.board.cards[id];
    if (!card) return null;
    const now = nowIso();
    if (card.column === 'working') {
      if (leftOffText) card.leftOff = { text: leftOffText, auto: true, at: now };
      this._log(card, 'status', 'Working → Needs Input', true);
      card.column = 'needs_input';
      card.autoMoved = true;
    }
    card.lastActiveAt = now;
    this._scheduleSave();
    return card;
  }

  markSessionEnded(id) {
    const card = this.board.cards[id];
    if (!card) return null;
    if (!card.sessionEndedAt) this._log(card, 'ended', 'Session ended');
    card.sessionEndedAt = nowIso();
    this._scheduleSave();
    return card;
  }

  moveCard(id, column, auto) {
    if (!this.validColumn(column)) return null;
    return this.updateCard(id, { column: column, auto: !!auto });
  }

  // ----- columns -----

  listColumns() {
    return this.board.columns;
  }

  validColumn(key) {
    return this.board.columns.some((c) => c.key === key);
  }

  getColumn(key) {
    return this.board.columns.find((c) => c.key === key) || null;
  }

  // Label for a column key, falling back to the raw key when the column no
  // longer exists (hand-edited board, card left in a deleted column) so
  // history logging never throws.
  columnLabel(key) {
    const col = this.getColumn(key);
    return col ? col.label : String(key || '(unknown)');
  }

  _nextCustomColor() {
    const used = new Set(this.board.columns.map((c) => c.color));
    return CUSTOM_PALETTE.find((c) => !used.has(c)) ||
      CUSTOM_PALETTE[this.board.columns.length % CUSTOM_PALETTE.length];
  }

  addColumn(label) {
    const clean = String(label || '').trim();
    if (!clean) return null;
    let key = slugify(clean);
    let n = 2;
    while (this.validColumn(key)) key = slugify(clean) + '_' + (n++);
    const col = { key: key, label: clean, kind: 'custom', color: this._nextCustomColor() };
    // Insert before the special "done" column so it stays last.
    const doneIdx = this.board.columns.findIndex((c) => c.kind === 'done');
    const at = doneIdx === -1 ? this.board.columns.length : doneIdx;
    this.board.columns.splice(at, 0, col);
    this._scheduleSave();
    return col;
  }

  renameColumn(key, label) {
    const col = this.getColumn(key);
    if (!col || col.kind !== 'custom') return null;
    const clean = String(label || '').trim();
    if (clean) col.label = clean;
    this._scheduleSave();
    return col;
  }

  // Reorder a column one slot left/right. "done" stays pinned last and cannot
  // be moved, and nothing can be moved past it.
  moveColumn(key, dir) {
    const cols = this.board.columns;
    const i = cols.findIndex((c) => c.key === key);
    if (i === -1 || cols[i].kind === 'done') return null;
    const j = dir === 'left' ? i - 1 : i + 1;
    if (j < 0 || j >= cols.length || cols[j].kind === 'done') return null;
    const tmp = cols[i]; cols[i] = cols[j]; cols[j] = tmp;
    this._scheduleSave();
    return cols;
  }

  // Delete a custom column. If it still holds cards, either reassign them to
  // another column (reassignTo) or archive them (archive:true). Returns
  // { ok, needsChoice, count } so the caller/UI can prompt when needed.
  removeColumn(key, opts) {
    const col = this.getColumn(key);
    if (!col || col.kind !== 'custom') return { ok: false, error: 'not a custom column' };
    const options = opts || {};
    const cards = Object.values(this.board.cards).filter((c) => c.column === key);

    if (cards.length && !options.archive && !options.reassignTo) {
      return { ok: false, needsChoice: true, count: cards.length };
    }
    if (cards.length) {
      if (options.archive) {
        cards.forEach((c) => this.archiveCard(c.id));
      } else {
        if (!this.validColumn(options.reassignTo) || options.reassignTo === key) {
          return { ok: false, error: 'invalid reassign target' };
        }
        cards.forEach((c) => this.updateCard(c.id, { column: options.reassignTo }));
      }
    }
    this.board.columns = this.board.columns.filter((c) => c.key !== key);
    this._scheduleSave();
    return { ok: true, count: cards.length };
  }

  archiveCard(id) {
    const card = this.board.cards[id];
    if (!card) return null;
    card.archivedAt = nowIso();
    // Remember where the card lived so a restore can put it back.
    card.archivedFrom = card.column;
    if (card.column !== 'done') {
      this._log(card, 'status', this.columnLabel(card.column) + ' → Done', false);
      card.column = 'done';
    }
    this._log(card, 'archived', 'Archived');
    this.archive.cards[id] = card;
    delete this.board.cards[id];
    this._archiveDirty = true;
    this._scheduleSave();
    return card;
  }

  restoreCard(id) {
    // Restore from archive back onto the board, or un-done an active card.
    if (this.archive.cards[id]) {
      const card = this.archive.cards[id];
      card.archivedAt = null;
      // Restore to the column it was archived from when that column still
      // exists; otherwise (old cards, deleted columns) fall back to review.
      const from = card.archivedFrom;
      card.column = (from && from !== 'done' && this.validColumn(from)) ? from : 'task_completed';
      card.archivedFrom = null;
      this.board.cards[id] = card;
      delete this.archive.cards[id];
      this._archiveDirty = true;
      this._scheduleSave();
      return card;
    }
    const card = this.board.cards[id];
    if (card) {
      return this.updateCard(id, { column: 'task_completed' });
    }
    return null;
  }

  deleteCard(id) {
    let removed = false;
    if (this.board.cards[id]) { delete this.board.cards[id]; removed = true; }
    if (this.archive.cards[id]) { delete this.archive.cards[id]; this._archiveDirty = true; removed = true; }
    if (removed) this._scheduleSave();
    return removed;
  }

  archiveAllDone() {
    const doneIds = Object.values(this.board.cards)
      .filter((c) => c.column === 'done')
      .map((c) => c.id);
    for (const id of doneIds) this.archiveCard(id);
    return doneIds.length;
  }
}

function normalizePath(p) {
  if (!p) return '';
  // Windows: case-insensitive, normalize separators, strip trailing slash.
  return String(p).replace(/[/\\]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

module.exports = { Store, DEFAULT_COLUMNS, DATA_DIR, normalizePath, nowIso, atomicWrite, readJsonSafe };
