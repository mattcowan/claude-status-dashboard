'use strict';

// In-memory board with a debounced, atomic on-disk save.
// The server is a single long-lived process, so all mutations funnel through
// this one module in one event loop -> no cross-process write races even when
// many Claude sessions post concurrently.

const fs = require('fs');
const path = require('path');

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
// e.g. C:\Users\...\loopchicago\app\public  -> "loopchicago"
//      C:\...\plugins\gf-data-anonymizer     -> "gf-data-anonymizer"
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
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
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
    }, 120);
    // Do not keep the process alive solely for a pending save.
    if (this._saveTimer.unref) this._saveTimer.unref();
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
  }

  // Append a timestamped entry to a card's activity history.
  // kind: 'created' | 'status' | 'update' | 'external' | 'ended' | 'archived'
  _log(card, kind, text, auto) {
    if (!Array.isArray(card.history)) card.history = [];
    card.history.push({ at: nowIso(), kind: kind, text: text, auto: !!auto });
  }

  // ----- reads -----

  listCards(projectFilter) {
    const cards = Object.values(this.board.cards);
    const filtered = projectFilter
      ? cards.filter((c) => c.project === projectFilter)
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

  projects() {
    const map = new Map();
    for (const c of Object.values(this.board.cards)) {
      if (!c.project) continue;
      const entry = map.get(c.project) || { project: c.project, projectLabel: c.projectLabel, count: 0 };
      entry.count += 1;
      map.set(c.project, entry);
    }
    return Array.from(map.values()).sort((a, b) =>
      String(a.projectLabel).localeCompare(String(b.projectLabel)));
  }

  getCard(id) {
    return this.board.cards[id] || null;
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

  upsertSession(id, project, source, repoUrl) {
    let card = this.board.cards[id];
    const now = nowIso();
    if (!card) {
      card = {
        id: id,
        project: project || '',
        projectLabel: friendlyLabel(project),
        repoUrl: repoUrl || null,
        column: 'working',
        headline: '',
        body: '',
        leftOff: null,
        autoMoved: false,
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
    this._scheduleSave();
    return card;
  }

  // Backfill repoUrl on existing cards (called once at server startup with a
  // resolver that reads each project's git remote).
  ensureRepoUrls(resolve) {
    let changed = false;
    for (const card of Object.values(this.board.cards)) {
      if (card.project && !card.repoUrl) {
        const url = resolve(card.project);
        if (url) { card.repoUrl = url; changed = true; }
      }
    }
    if (changed) this._scheduleSave();
  }

  updateCard(id, fields) {
    const card = this.board.cards[id];
    if (!card) return null;
    const now = nowIso();

    let contentChanged = false;
    if (typeof fields.headline === 'string' && fields.headline !== card.headline) { card.headline = fields.headline; contentChanged = true; }
    if (typeof fields.body === 'string' && fields.body !== card.body) { card.body = fields.body; contentChanged = true; }

    let bulletAdded = false;
    if (typeof fields.appendBullet === 'string' && fields.appendBullet.trim()) {
      const bullet = '- ' + fields.appendBullet.trim();
      card.body = card.body && card.body.trim() ? card.body.replace(/\s+$/, '') + '\n' + bullet : bullet;
      bulletAdded = true;
    }

    if (fields.column && this.validColumn(fields.column) && fields.column !== card.column) {
      this._log(card, 'status', this.getColumn(card.column).label + ' → ' + this.getColumn(fields.column).label, !!fields.auto);
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

    card.updatedAt = now;
    card.lastActiveAt = now;
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
    if (card.column !== 'done') {
      this._log(card, 'status', this.getColumn(card.column).label + ' → Done', false);
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
      card.column = 'task_completed';
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

module.exports = { Store, DEFAULT_COLUMNS, DATA_DIR, normalizePath, nowIso };
