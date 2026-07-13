'use strict';

const state = {
  cards: [],
  columns: [],   // [{key,label,kind,color}] from the server
  project: '',
  showDone: false,
  archiveOpen: false,
  openHistory: new Set(),  // card ids whose History section is expanded (kept across refreshes)
  fillWidth: true,         // columns grow to fill wide screens (persisted)
  expanded: new Set(),     // card ids explicitly expanded (default is collapsed; persisted)
};

// ---------- preferences (localStorage) ----------

const PREFS_KEY = 'claude-dashboard-prefs';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? JSON.parse(raw) : {};
    state.fillWidth = p.fillWidth !== false;   // default ON
    state.expanded = new Set(Array.isArray(p.expanded) ? p.expanded : []);
  } catch (_) { /* storage unavailable — keep defaults */ }
}

function savePrefs() {
  try {
    // Prune expanded ids to cards currently on the board so it can't grow unbounded.
    const onBoard = new Set(state.cards.map((c) => c.id));
    const expanded = Array.from(state.expanded).filter((id) => onBoard.has(id));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ fillWidth: state.fillWidth, expanded }));
  } catch (_) { /* best effort */ }
}

// ---------- helpers ----------

// "claude-opus-4-8" -> "Opus 4.8"; "claude-haiku-4-5-20251001" -> "Haiku 4.5".
// Falls back to the raw id when it doesn't match the expected shape.
function prettyModel(id) {
  if (!id) return '';
  let s = String(id).replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
  const m = s.match(/(opus|sonnet|haiku|fable)-?(.*)$/i);
  if (!m) return String(id);
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  const version = m[2].replace(/[-_]/g, '.').replace(/\.+$/, '');
  const oneMillion = /\[1m\]$/i.test(String(id)) ? ' (1M)' : '';
  return (version ? family + ' ' + version : family) + oneMillion;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
  }
  (children || []).forEach((c) => { if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return node;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "https://github.com/owner/repo" -> "owner/repo" for a compact link label.
function repoShortLabel(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.slice(-2).join('/') || url;
  } catch (_) { return url; }
}

function colOf(key) { return state.columns.find((c) => c.key === key) || null; }
function colorOf(key) { const c = colOf(key); return c ? c.color : 'var(--muted)'; }
function labelOf(key) { const c = colOf(key); return c ? c.label : key; }

function renderBody(text) {
  if (!text) return el('div', { class: 'body' }, []);
  const lines = String(text).split(/\n/);
  const frag = document.createDocumentFragment();
  let ul = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^[-*]\s+/.test(t)) {
      if (!ul) { ul = document.createElement('ul'); frag.appendChild(ul); }
      const li = document.createElement('li');
      li.textContent = t.replace(/^[-*]\s+/, '');
      ul.appendChild(li);
    } else if (t) {
      ul = null;
      const p = document.createElement('p');
      p.textContent = t;
      frag.appendChild(p);
    }
  }
  const wrap = el('div', { class: 'body' }, []);
  wrap.appendChild(frag);
  return wrap;
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

// Local wall-clock time, e.g. "8:59 PM".
function clockTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// Clock time, prefixed with the date when it isn't today, e.g. "Jul 10, 8:59 PM".
function dateClock(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? clockTime(iso) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + clockTime(iso);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, ok: res.ok, json };
}

// ---------- data ----------

async function refresh() {
  const q = state.project ? '?project=' + encodeURIComponent(state.project) : '';
  const data = (await api('GET', '/api/board' + q)).json;
  state.cards = (data && data.cards) || [];
  state.columns = (data && data.columns) || [];
  render();
  await refreshProjects();
  document.getElementById('refreshNote').textContent = 'updated ' + new Date().toLocaleTimeString();
  if (state.archiveOpen) refreshArchive();
}

async function refreshProjects() {
  const data = (await api('GET', '/api/projects')).json;
  const sel = document.getElementById('projectFilter');
  const current = state.project;
  const opts = ['<option value="">All projects</option>'];
  ((data && data.projects) || []).forEach((p) => {
    opts.push('<option value="' + escapeHtml(p.project) + '"' + (p.project === current ? ' selected' : '') + '>' +
      escapeHtml(p.projectLabel) + ' (' + p.count + ')</option>');
  });
  sel.innerHTML = opts.join('');
}

async function refreshArchive() {
  const data = (await api('GET', '/api/archive')).json;
  const list = document.getElementById('archiveList');
  list.innerHTML = '';
  const cards = (data && data.cards) || [];
  if (!cards.length) { list.appendChild(el('div', { class: 'col-empty', text: 'Nothing archived yet.' }, [])); return; }
  cards.forEach((c) => list.appendChild(cardNode(c, true)));
}

// ---------- card ----------

function badge(cls, children) { return el('span', { class: 'badge ' + cls }, children); }

// Format one history entry, tolerating the old {from,to,auto} shape as well as
// the current {kind,text,auto} shape.
function historyText(h) {
  if (h.text) return h.text;
  if ('to' in h) return (h.from ? labelOf(h.from) : 'Created') + ' → ' + labelOf(h.to);
  return '(change)';
}

function historyNode(history, cardId) {
  const rows = history.slice().reverse().map((h) => el('li', { class: 'history-item' }, [
    el('span', { class: 'h-time', text: dateClock(h.at) }, []),
    el('span', { class: 'h-text', text: historyText(h) }, []),
    h.auto ? el('span', { class: 'h-auto', text: 'auto' }, []) : null,
  ]));
  const details = el('details', { class: 'history' }, [
    el('summary', {}, ['History (' + history.length + ')']),
    el('ul', { class: 'history-list' }, rows),
  ]);
  // Keep the expanded state across the 3s auto-refresh re-renders.
  if (state.openHistory.has(cardId)) details.open = true;
  details.addEventListener('toggle', () => {
    if (details.open) state.openHistory.add(cardId);
    else state.openHistory.delete(cardId);
  });
  return details;
}

function cardNode(card, inArchive) {
  const node = el('div', {
    class: 'card',
    style: 'border-left-color:' + colorOf(card.column),
    draggable: inArchive ? null : 'true',
    'data-id': card.id,
  }, []);

  if (!inArchive) {
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.id);
      e.dataTransfer.effectAllowed = 'move';
    });
  }

  // Collapsed is the default; only ids explicitly expanded show full detail.
  // Archived cards are always shown expanded (no collapse affordance there).
  const isExpanded = inArchive || state.expanded.has(card.id);

  const headlineEl = card.headline
    ? el('div', { class: 'headline', text: card.headline }, [])
    : el('div', { class: 'headline' }, [el('span', { class: 'placeholder', text: '(no headline yet)' }, [])]);

  const head = el('div', { class: 'card-head' }, [headlineEl]);
  if (!inArchive) {
    const caret = el('button', {
      class: 'card-caret' + (isExpanded ? ' open' : ''),
      title: isExpanded ? 'Collapse' : 'Expand',
      'aria-expanded': isExpanded ? 'true' : 'false',
      'aria-label': isExpanded ? 'Collapse card' : 'Expand card',
      onclick: (e) => {
        e.stopPropagation();
        if (state.expanded.has(card.id)) state.expanded.delete(card.id);
        else state.expanded.add(card.id);
        savePrefs();
        render();
      },
    }, ['▸']);
    // Don't let a press on the caret start a card drag.
    caret.addEventListener('mousedown', (e) => e.stopPropagation());
    head.appendChild(caret);
  }
  node.appendChild(head);

  const badges = el('div', { class: 'badges' }, []);
  const proj = badge('project', ['📁 ' + (card.projectLabel || '(unknown)')]);
  if (card.project) proj.setAttribute('title', card.project);
  badges.appendChild(proj);
  if (card.repoUrl) {
    badges.appendChild(el('a', {
      class: 'badge repo',
      href: card.repoUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: card.repoUrl,
    }, ['↗ ' + repoShortLabel(card.repoUrl)]));
  }
  if (card.model) badges.appendChild(badge('model', [prettyModel(card.model)]));
  if (card.autoMoved || (card.leftOff && card.leftOff.auto)) badges.appendChild(badge('auto', ['⚙ auto-captured']));
  if (!inArchive) {
    if (card.sessionEndedAt) badges.appendChild(badge('ended', [el('span', { class: 'live-dot' }, []), 'ended']));
    else badges.appendChild(badge('live', [el('span', { class: 'live-dot' }, []), 'live']));
  }
  node.appendChild(badges);

  if (isExpanded) {
    if (card.body) node.appendChild(renderBody(card.body));

    if (card.leftOff && card.leftOff.text) {
      node.appendChild(el('div', { class: 'leftoff' }, [
        el('span', { class: 'lo-label', text: 'Where it left off' }, []),
        document.createTextNode(card.leftOff.text),
      ]));
    }

    if (card.externalEdits && card.externalEdits.length) {
      const ul = el('ul', {}, card.externalEdits.map((f) => el('li', { text: f }, [])));
      node.appendChild(el('div', { class: 'external' }, [
        el('span', { class: 'ex-label', text: '⚠ Edits outside this project' }, []),
        ul,
      ]));
    }

    node.appendChild(el('div', { class: 'meta' }, [
      'active ' + relTime(card.lastActiveAt) + ' (' + clockTime(card.lastActiveAt) + ')',
      card.createdAt ? el('span', { text: ' · started ' + relTime(card.createdAt) + ' (' + clockTime(card.createdAt) + ')' }, []) : null,
    ]));

    if (Array.isArray(card.history) && card.history.length) {
      node.appendChild(historyNode(card.history, card.id));
    }
  }

  const actions = el('div', { class: 'actions' }, []);
  if (inArchive) {
    actions.appendChild(el('button', { class: 'small', onclick: () => act(card.id, 'restore') }, ['Restore']));
    actions.appendChild(el('button', { class: 'small ghost', onclick: () => del(card.id) }, ['Delete']));
  } else {
    if (card.column !== 'done') {
      actions.appendChild(el('button', { class: 'small primary', onclick: () => act(card.id, 'done') }, ['✓ Mark done']));
    } else {
      actions.appendChild(el('button', { class: 'small', onclick: () => act(card.id, 'restore') }, ['Restore']));
    }
    actions.appendChild(el('button', { class: 'small ghost', onclick: () => act(card.id, 'archive') }, ['Archive']));
  }
  node.appendChild(actions);

  return node;
}

// ---------- board render ----------

function columnHead(col, count, index, visibleKeys) {
  const controls = el('div', { class: 'col-controls' }, []);

  // Reorder arrows (not for the pinned "done" column).
  if (col.kind !== 'done') {
    const leftKey = visibleKeys[index - 1];
    const rightKey = visibleKeys[index + 1];
    const canLeft = leftKey && colOf(leftKey).kind !== 'done';
    const canRight = rightKey && colOf(rightKey).kind !== 'done';
    controls.appendChild(el('button', {
      class: 'col-btn', title: 'Move left', disabled: canLeft ? null : 'true',
      onclick: () => reorderColumn(col.key, 'left'),
    }, ['‹']));
    controls.appendChild(el('button', {
      class: 'col-btn', title: 'Move right', disabled: canRight ? null : 'true',
      onclick: () => reorderColumn(col.key, 'right'),
    }, ['›']));
  }
  // Rename + delete (custom columns only).
  if (col.kind === 'custom') {
    controls.appendChild(el('button', { class: 'col-btn', title: 'Rename', onclick: () => renameColumn(col) }, ['✎']));
    controls.appendChild(el('button', { class: 'col-btn danger', title: 'Delete column', onclick: () => deleteColumn(col) }, ['×']));
  }

  return el('div', { class: 'col-head' }, [
    el('span', { class: 'swatch', style: 'background:' + col.color }, []),
    el('span', { class: 'col-label', text: col.label }, []),
    el('span', { class: 'count', text: String(count) }, []),
    controls,
  ]);
}

function render() {
  const board = document.getElementById('boardView');
  board.innerHTML = '';
  board.classList.toggle('fill', state.fillWidth);

  const visible = state.columns.filter((c) => c.kind !== 'done' || state.showDone);
  const visibleKeys = visible.map((c) => c.key);

  const byCol = {};
  visible.forEach((c) => { byCol[c.key] = []; });
  state.cards.forEach((card) => { if (byCol[card.column]) byCol[card.column].push(card); });

  visible.forEach((col, index) => {
    const colEl = el('div', { class: 'column' + (col.kind === 'custom' ? ' custom' : ''), 'data-col': col.key }, []);

    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('dragover'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('dragover'));
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      if (id) move(id, col.key);
    });

    colEl.appendChild(columnHead(col, byCol[col.key].length, index, visibleKeys));

    const bodyEl = el('div', { class: 'col-body' }, []);
    if (!byCol[col.key].length) bodyEl.appendChild(el('div', { class: 'col-empty', text: '—' }, []));
    else byCol[col.key].forEach((card) => bodyEl.appendChild(cardNode(card, false)));
    colEl.appendChild(bodyEl);

    board.appendChild(colEl);
  });

  // Trailing "add column" affordance.
  board.appendChild(el('div', { class: 'add-col-tile', onclick: addColumn, title: 'Add a column' }, ['＋ Add column']));
}

// ---------- card actions ----------

async function move(id, column) { await api('POST', '/api/cards/' + encodeURIComponent(id) + '/move', { column }); refresh(); }
async function act(id, action) { await api('POST', '/api/cards/' + encodeURIComponent(id) + '/' + action); refresh(); }
async function del(id) {
  if (!confirm('Delete this archived session permanently?')) return;
  await api('DELETE', '/api/cards/' + encodeURIComponent(id));
  refresh();
}

// ---------- column actions ----------

async function addColumn() {
  const label = prompt('New column name:', '');
  if (!label || !label.trim()) return;
  await api('POST', '/api/columns', { label: label.trim() });
  refresh();
}
async function renameColumn(col) {
  const label = prompt('Rename column:', col.label);
  if (label == null) return;
  await api('POST', '/api/columns/' + encodeURIComponent(col.key), { label: label.trim() });
  refresh();
}
async function reorderColumn(key, dir) {
  await api('POST', '/api/columns/' + encodeURIComponent(key) + '/reorder', { dir });
  refresh();
}
async function deleteColumn(col) {
  const count = state.cards.filter((c) => c.column === col.key).length;
  if (count === 0) {
    if (!confirm('Delete the “' + col.label + '” column?')) return;
    await api('DELETE', '/api/columns/' + encodeURIComponent(col.key));
    refresh();
    return;
  }
  openDeleteModal(col, count);
}

// Modal for deleting a column that still holds cards.
function openDeleteModal(col, count) {
  const others = state.columns.filter((c) => c.key !== col.key);
  const select = el('select', { id: 'reassignSelect' },
    others.map((c) => el('option', { value: c.key, text: c.label + (c.kind === 'done' ? ' (hidden)' : '') }, [])));

  const overlay = el('div', { class: 'modal-overlay' }, []);
  const close = () => document.body.removeChild(overlay);

  const modal = el('div', { class: 'modal' }, [
    el('h3', { text: 'Delete “' + col.label + '”' }, []),
    el('p', { class: 'modal-note', text: 'This column still holds ' + count + ' card' + (count === 1 ? '' : 's') + '. What should happen to them?' }, []),
    el('div', { class: 'modal-row' }, [
      el('span', { text: 'Move them to:' }, []),
      select,
      el('button', { class: 'small primary', onclick: async () => {
        await api('DELETE', '/api/columns/' + encodeURIComponent(col.key) + '?reassign=' + encodeURIComponent(select.value));
        close(); refresh();
      } }, ['Move & delete']),
    ]),
    el('div', { class: 'modal-row' }, [
      el('button', { class: 'small', onclick: async () => {
        await api('DELETE', '/api/columns/' + encodeURIComponent(col.key) + '?archive=1');
        close(); refresh();
      } }, ['Archive all ' + count + ' & delete']),
      el('button', { class: 'small ghost', onclick: close }, ['Cancel']),
    ]),
  ]);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// ---------- view controls ----------

// Expand every visible card, or collapse them all.
function setAllExpanded(expand) {
  if (expand) {
    const visibleDone = state.showDone;
    state.cards.forEach((c) => {
      if (c.column === 'done' && !visibleDone) return;
      state.expanded.add(c.id);
    });
  } else {
    state.expanded.clear();
  }
  savePrefs();
  render();
}

// ---------- wiring ----------

loadPrefs();

document.getElementById('projectFilter').addEventListener('change', (e) => { state.project = e.target.value; refresh(); });
document.getElementById('showDone').addEventListener('change', (e) => { state.showDone = e.target.checked; render(); });
const fillWidthEl = document.getElementById('fillWidth');
fillWidthEl.checked = state.fillWidth;
fillWidthEl.addEventListener('change', (e) => { state.fillWidth = e.target.checked; savePrefs(); render(); });
document.getElementById('expandAll').addEventListener('click', () => setAllExpanded(true));
document.getElementById('collapseAll').addEventListener('click', () => setAllExpanded(false));
document.getElementById('addColumn').addEventListener('click', addColumn);
document.getElementById('archiveView').addEventListener('click', () => {
  state.archiveOpen = !state.archiveOpen;
  document.getElementById('archiveSection').classList.toggle('hidden', !state.archiveOpen);
  document.getElementById('boardView').classList.toggle('hidden', state.archiveOpen);
  document.getElementById('archiveView').textContent = state.archiveOpen ? '← Back to board' : 'Archive…';
  if (state.archiveOpen) refreshArchive();
});
document.getElementById('archiveDone').addEventListener('click', async () => {
  await api('POST', '/api/archive-done');
  refresh();
});

refresh();
setInterval(() => { if (!state.archiveOpen) refresh(); }, 3000);
