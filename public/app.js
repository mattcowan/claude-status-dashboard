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
  notify: false,           // desktop notifications on Needs Input / review (persisted)
  usage: null,             // last usage-limits snapshot from /api/usage
};

// Column state from the previous refresh, for notification diffing. null until
// the first refresh completes so a page load never fires a backlog of toasts.
let prevColumns = null;
let sseHealthy = false;

// ---------- preferences (localStorage) ----------

const PREFS_KEY = 'claude-dashboard-prefs';

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? JSON.parse(raw) : {};
    state.fillWidth = p.fillWidth !== false;   // default ON
    state.showDone = p.showDone === true;      // default OFF
    state.notify = p.notify === true;          // default OFF
    state.expanded = new Set(Array.isArray(p.expanded) ? p.expanded : []);
  } catch (_) { /* storage unavailable — keep defaults */ }
}

function savePrefs() {
  try {
    // Prune expanded ids to cards currently on the board so it can't grow unbounded.
    const onBoard = new Set(state.cards.map((c) => c.id));
    const expanded = Array.from(state.expanded).filter((id) => onBoard.has(id));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ fillWidth: state.fillWidth, showDone: state.showDone, notify: state.notify, expanded }));
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

// A session with no activity for this long gets the 💤 badge (never dimmed).
const STALE_MS = 10 * 60 * 1000;
function isStale(card) {
  if (card.sessionEndedAt || !card.lastActiveAt) return false;
  const t = new Date(card.lastActiveAt).getTime();
  return !isNaN(t) && Date.now() - t > STALE_MS;
}

// Branch link only for github.com repos — other hosts use different tree paths.
function githubBranchUrl(repoUrl, branch) {
  if (!repoUrl || !branch) return null;
  try {
    if (new URL(repoUrl).hostname !== 'github.com') return null;
    return repoUrl.replace(/\/$/, '') + '/tree/' + encodeURIComponent(branch);
  } catch (_) { return null; }
}

// "C:\Users\me\.claude\projects\foo\abc.jsonl" -> "foo\abc.jsonl"
function shortPath(p) {
  const parts = String(p).split(/[/\\]+/).filter(Boolean);
  return parts.slice(-2).join('\\') || String(p);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback for contexts where the async clipboard is unavailable.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }
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
  notifyColumnChanges();
  render();
  refreshUsage(); // fire-and-forget; strip renders when it lands
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

  // Headline fallback chain: explicit headline → the auto-generated session
  // title from the transcript (the VS Code tab title) → placeholder.
  const headlineEl = card.headline
    ? el('div', { class: 'headline', text: card.headline }, [])
    : (card.autoTitle
      ? el('div', { class: 'headline auto-title', title: 'Auto-generated session title', text: card.autoTitle }, [])
      : el('div', { class: 'headline' }, [el('span', { class: 'placeholder', text: '(no headline yet)' }, [])]));

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
  if (card.gitBranch) {
    const branchUrl = githubBranchUrl(card.repoUrl, card.gitBranch);
    badges.appendChild(branchUrl
      ? el('a', { class: 'badge branch', href: branchUrl, target: '_blank', rel: 'noopener noreferrer', title: 'Open branch on GitHub' }, ['⎇ ' + card.gitBranch])
      : el('span', { class: 'badge branch', title: 'Git branch' }, ['⎇ ' + card.gitBranch]));
  }
  if (card.model) badges.appendChild(badge('model', [prettyModel(card.model)]));
  if (card.autoMoved || (card.leftOff && card.leftOff.auto)) badges.appendChild(badge('auto', ['⚙ auto-captured']));
  const stale = !inArchive && isStale(card);
  if (stale) {
    const b = badge('stale', ['💤 ' + relTime(card.lastActiveAt)]);
    b.setAttribute('title', 'No activity for over 10 minutes');
    badges.appendChild(b);
  }
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

    if (card.slug || card.transcriptPath) {
      const links = el('div', { class: 'card-links' }, []);
      if (card.slug) {
        links.appendChild(el('button', { class: 'small ghost', onclick: () => openPlanModal(card) }, ['📄 Plan']));
      }
      if (card.transcriptPath) {
        const code = el('code', { title: card.transcriptPath, text: shortPath(card.transcriptPath) }, []);
        const copyBtn = el('button', { class: 'small ghost', title: 'Copy transcript path' }, ['📋']);
        copyBtn.addEventListener('click', async () => {
          const ok = await copyText(card.transcriptPath);
          copyBtn.textContent = ok ? 'copied' : 'copy failed';
          setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
        });
        links.appendChild(code);
        links.appendChild(copyBtn);
      }
      node.appendChild(links);
    }

    node.appendChild(el('div', { class: 'meta' + (stale ? ' stale' : '') }, [
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

  // The Done column gets an always-visible "Dump → archive" button (mirrors the
  // topbar action), but only when it actually holds cards to move.
  const doneArchive = (col.kind === 'done' && count > 0)
    ? el('button', {
        class: 'small ghost col-head-action',
        title: 'Move all done cards to the archive',
        onclick: archiveDone,
      }, ['Dump → archive'])
    : null;

  return el('div', { class: 'col-head' }, [
    el('span', { class: 'swatch', style: 'background:' + col.color }, []),
    el('span', { class: 'col-label', text: col.label }, []),
    el('span', { class: 'count', text: String(count) }, []),
    doneArchive,
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

// ---------- plan viewer ----------

// Show the plan file(s) Claude Code wrote for a session (~/.claude/plans).
// Appended to document.body so the 3s board re-render can't destroy it.
async function openPlanModal(card) {
  const overlay = el('div', { class: 'modal-overlay' }, []);
  const close = () => document.body.removeChild(overlay);

  const title = el('h3', { text: 'Plan — ' + (card.headline || card.autoTitle || card.slug) }, []);
  const content = el('div', {}, [el('p', { class: 'modal-note', text: 'Loading…' }, [])]);
  const modal = el('div', { class: 'modal wide' }, [
    title,
    content,
    el('div', { class: 'modal-row' }, [el('button', { class: 'small ghost', onclick: close }, ['Close'])]),
  ]);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);

  async function load(file) {
    const q = file ? '?file=' + encodeURIComponent(file) : '';
    const r = await api('GET', '/api/cards/' + encodeURIComponent(card.id) + '/plan' + q);
    content.innerHTML = '';
    if (!r.ok || !r.json || !r.json.ok) {
      content.appendChild(el('p', { class: 'modal-note', text: (r.json && r.json.error) || 'Could not load the plan.' }, []));
      return;
    }
    if (r.json.files && r.json.files.length > 1) {
      const select = el('select', {},
        r.json.files.map((f) => el('option', { value: f, text: f, selected: f === r.json.file ? 'selected' : null }, [])));
      select.addEventListener('change', () => load(select.value));
      content.appendChild(el('div', { class: 'modal-row' }, [el('span', { text: 'File:' }, []), select]));
    } else {
      content.appendChild(el('p', { class: 'modal-note', text: r.json.file }, []));
    }
    const pre = el('pre', { class: 'plan-pre' }, []);
    pre.textContent = r.json.markdown; // textContent keeps it XSS-safe, zero-dep
    content.appendChild(pre);
  }
  load(null);
}

// ---------- usage limits strip ----------

// Reset time, compact: today -> "resets 3:00 PM"; within a week -> "resets Wed";
// beyond -> "resets Jul 24, 3:00 PM".
function formatReset(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = d.getTime() - Date.now();
  if (diff < 24 * 3600 * 1000) return 'resets ' + clockTime(iso);
  if (diff < 7 * 24 * 3600 * 1000) return 'resets ' + d.toLocaleDateString([], { weekday: 'short' }) + ' ' + clockTime(iso);
  return 'resets ' + dateClock(iso);
}

// Where usage "should" be if it were spread evenly across the window: the
// fraction of the window already elapsed. window start = resetsAt - windowMs.
// Returns 0-100, or null when we don't know the window length.
function pacePercent(b) {
  if (!b || !b.windowMs || !b.resetsAt) return null;
  const reset = new Date(b.resetsAt).getTime();
  if (isNaN(reset)) return null;
  const remaining = reset - Date.now();
  const elapsed = b.windowMs - remaining;
  return Math.max(0, Math.min(100, (elapsed / b.windowMs) * 100));
}

// Human explanation of the pace marker (hover tooltip).
function paceTooltip(b, pace) {
  if (pace == null) return null;
  const paceR = Math.round(pace);
  if (b.pct == null) return 'Even pace ≈ ' + paceR + '% used by now';
  const diff = Math.round(b.pct - pace);
  const rel = diff > 2 ? diff + '% ahead of pace — on track to exceed'
    : diff < -2 ? Math.abs(diff) + '% under pace'
    : 'on pace';
  return 'Even pace ≈ ' + paceR + '% by now · you’re at ' + Math.round(b.pct) + '% (' + rel + ')';
}

// Full reset date for the hover tooltip, e.g. "Tue, Jul 21, 2026, 10:00 PM".
function fullReset(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return 'Resets ' + d.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

async function refreshUsage() {
  const r = await api('GET', '/api/usage');
  if (r.json) { state.usage = r.json; renderUsage(); }
}

function renderUsage() {
  const strip = document.getElementById('usageStrip');
  const u = state.usage;
  if (!u) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  strip.innerHTML = '';

  if (u.status === 'never') {
    strip.appendChild(el('span', { class: 'u-note', text: 'No usage data yet' }, []));
  } else if (u.status === 'auth' && !(u.buckets && u.buckets.length)) {
    strip.appendChild(el('span', { class: 'u-error', text: '⚠ Usage unavailable: ' + (u.error || 'auth needed') }, []));
  } else {
    (u.buckets || []).forEach((b) => {
      const pct = b.pct == null ? null : b.pct;
      const cls = pct == null ? 'ok' : (pct >= 85 ? 'crit' : (pct >= 60 ? 'warn' : 'ok'));
      const pace = pacePercent(b);
      const tip = paceTooltip(b, pace);
      strip.appendChild(el('span', { class: 'u-meter' }, [
        el('span', { class: 'u-label', text: b.label }, []),
        el('span', { class: 'u-bar', title: tip }, [
          el('span', { class: 'u-fill ' + cls, style: 'display:block;width:' + (pct == null ? 0 : pct) + '%' }, []),
          pace == null ? null : el('span', {
            class: 'u-pace' + (pct != null && pct - pace > 2 ? ' over' : ''),
            style: 'left:' + pace + '%',
            title: tip,
          }, []),
        ]),
        el('span', { class: 'u-pct', text: pct == null ? '—' : pct + '%' }, []),
        b.resetsAt ? el('span', { class: 'u-reset', title: fullReset(b.resetsAt), text: formatReset(b.resetsAt) }, []) : null,
      ]));
    });
    if (u.status !== 'ok' && u.error) {
      strip.appendChild(el('span', { class: 'u-error', text: '⚠ ' + u.error }, []));
    }
  }

  const controls = el('span', { class: 'u-controls' }, []);
  if (u.fetchedAt) {
    controls.appendChild(el('span', { class: 'u-note' + (u.stale ? ' stale' : ''), text: 'usage as of ' + relTime(u.fetchedAt) }, []));
  }
  const refreshBtn = el('button', { class: 'small ghost', title: 'Refresh usage now' }, ['↻']);
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    const r = await api('POST', '/api/usage/refresh');
    if (r.json) state.usage = r.json;
    renderUsage();
  });
  controls.appendChild(refreshBtn);
  controls.appendChild(el('span', {
    class: 'u-info',
    text: 'ⓘ',
    title: "Read from Anthropic's undocumented OAuth usage endpoint — buckets and labels may change or break without notice.",
  }, []));
  const settingsBtn = el('button', { class: 'small ghost', title: 'Usage settings' }, ['⚙']);
  settingsBtn.addEventListener('click', openUsageSettings);
  controls.appendChild(settingsBtn);
  strip.appendChild(controls);
}

async function openUsageSettings() {
  const current = (await api('GET', '/api/settings')).json || { usagePoll: { enabled: false, intervalMs: 600000 } };
  const overlay = el('div', { class: 'modal-overlay' }, []);
  const close = () => document.body.removeChild(overlay);

  const enabled = el('input', { type: 'checkbox' }, []);
  enabled.checked = !!current.usagePoll.enabled;
  const interval = el('select', {}, [
    el('option', { value: '300000', text: 'every 5 min' }, []),
    el('option', { value: '600000', text: 'every 10 min' }, []),
    el('option', { value: '1800000', text: 'every 30 min' }, []),
  ]);
  interval.value = String(current.usagePoll.intervalMs);
  if (!interval.value) interval.value = '600000';

  const modal = el('div', { class: 'modal' }, [
    el('h3', { text: 'Usage settings' }, []),
    el('p', { class: 'modal-note', text: 'Usage refreshes when sessions ping the dashboard and via the ↻ button. Background polling pings the (undocumented) endpoint on a timer even when nothing is active — off by default.' }, []),
    el('div', { class: 'modal-row' }, [
      el('label', { class: 'toggle' }, [enabled, ' Auto-poll usage']),
      interval,
    ]),
    el('div', { class: 'modal-row' }, [
      el('button', { class: 'small primary', onclick: async () => {
        await api('POST', '/api/settings', {
          usagePoll: { enabled: enabled.checked, intervalMs: parseInt(interval.value, 10) },
        });
        close();
      } }, ['Save']),
      el('button', { class: 'small ghost', onclick: close }, ['Cancel']),
    ]),
  ]);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// ---------- desktop notifications ----------

// Toast when an EXISTING card moves into Needs Input / Ready for Review.
// prevColumns is null on the first refresh, so a page load never notifies.
function notifyColumnChanges() {
  const cards = state.cards;
  if (prevColumns !== null && state.notify &&
      typeof Notification !== 'undefined' && Notification.permission === 'granted' &&
      !document.hasFocus()) {
    for (const card of cards) {
      const before = prevColumns.get(card.id);
      if (!before || before === card.column) continue;
      if (card.column !== 'needs_input' && card.column !== 'task_completed') continue;
      try {
        const n = new Notification(labelOf(card.column) + ': ' + (card.projectLabel || ''), {
          body: card.headline || card.autoTitle || card.id,
          tag: card.id, // collapses repeat toasts for the same card
        });
        n.onclick = () => window.focus();
      } catch (_) { /* notifications unavailable */ }
    }
  }
  // Rebuild unconditionally so toggling notify on later has a clean baseline.
  prevColumns = new Map(cards.map((c) => [c.id, c.column]));
}

// ---------- view controls ----------

// Move every card in the Done column into the archive.
async function archiveDone() {
  await api('POST', '/api/archive-done');
  refresh();
}

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
const showDoneEl = document.getElementById('showDone');
showDoneEl.checked = state.showDone;
showDoneEl.addEventListener('change', (e) => { state.showDone = e.target.checked; savePrefs(); render(); });
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
document.getElementById('archiveDone').addEventListener('click', archiveDone);

// Notifications opt-in: permission is requested only from this explicit
// gesture, never on page load.
const notifyEl = document.getElementById('notifyToggle');
notifyEl.checked = state.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
state.notify = notifyEl.checked;
notifyEl.addEventListener('change', async (e) => {
  if (!e.target.checked) { state.notify = false; savePrefs(); return; }
  if (typeof Notification === 'undefined') { e.target.checked = false; return; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { e.target.checked = false; state.notify = false; savePrefs(); return; }
  state.notify = true;
  savePrefs();
});

// ---------- live updates ----------
// SSE is the primary signal; polling stays as a fallback (3s when SSE is down,
// a slow 15s heartbeat when it's healthy, covering missed reconnect windows).

// Exactly one tab opens the stream. A browser allows only 6 concurrent HTTP/1.1
// connections per origin and an EventSource holds one open indefinitely, so a
// stream per tab meant six open dashboards saturated the pool: every later fetch
// (initial board load, card drag) queued forever with no error and no console
// output. The leader tab holds an exclusive Web Lock, owns the only stream, and
// fans 'changed' out over BroadcastChannel; followers open no stream at all.
// The browser releases the lock when the leader closes or crashes, promoting a
// waiting follower automatically — so this needs no heartbeat-based election.
const SSE_LOCK = 'claude-board-sse';
const SSE_CHANNEL = 'claude-board-events';
const LEADER_BEAT_MS = 10000;
// Followers fall back to fast polling once the leader has been quiet this long,
// which covers a leader frozen by tab-discarding (it still holds the lock, so
// no promotion happens) as well as one whose own stream has dropped.
const LEADER_STALE_MS = 30000;

let sseRefreshTimer = null;
let sseChannel = null;
let isLeader = false;
let lastLeaderBeat = 0;

function onBoardChanged() {
  // Small debounce so a burst of change events becomes one fetch.
  if (sseRefreshTimer) return;
  sseRefreshTimer = setTimeout(() => {
    sseRefreshTimer = null;
    if (!state.archiveOpen) refresh().catch(() => {});
  }, 300);
}

function openStream() {
  const es = new EventSource('/api/events');
  es.addEventListener('changed', () => {
    onBoardChanged();
    // BroadcastChannel never echoes to the sender, so the leader refreshes
    // itself above and notifies everyone else here.
    if (sseChannel) sseChannel.postMessage({ type: 'changed' });
  });
  es.onopen = () => { sseHealthy = true; };
  es.onerror = () => { sseHealthy = false; }; // EventSource auto-reconnects
  return es;
}

function initSSE() {
  if (typeof EventSource === 'undefined') return;

  // Without both primitives every tab runs its own stream, exactly as before —
  // still correct, just back to competing for the connection pool. Web Locks
  // needs a secure context, which 127.0.0.1 and localhost both satisfy.
  if (typeof BroadcastChannel === 'undefined' || !navigator.locks) {
    openStream();
    return;
  }

  sseChannel = new BroadcastChannel(SSE_CHANNEL);
  sseChannel.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'changed') {
      lastLeaderBeat = Date.now();
      onBoardChanged();
    } else if (msg.type === 'beat') {
      lastLeaderBeat = Date.now();
      sseHealthy = !!msg.healthy;
    }
  };

  // Assume the incumbent is working until proven otherwise, so a newly opened
  // follower doesn't poll hard through the window before the first beat lands.
  lastLeaderBeat = Date.now();
  sseHealthy = true;

  // The promise deliberately never settles: the lock is held for the life of
  // the tab and released only when the tab goes away.
  navigator.locks.request(SSE_LOCK, () => new Promise(() => {
    isLeader = true;
    openStream();
    setInterval(() => {
      sseChannel.postMessage({ type: 'beat', healthy: sseHealthy });
    }, LEADER_BEAT_MS);
  }));
}

// The leader answers for its own stream; a follower is only covered while the
// leader keeps checking in.
function sseCovered() {
  if (isLeader || !sseChannel) return sseHealthy;
  return sseHealthy && (Date.now() - lastLeaderBeat) < LEADER_STALE_MS;
}

function schedulePoll() {
  setTimeout(async () => {
    // A failed refresh (server restarting, network hiccup) must never break
    // the polling chain — that's the whole point of the fallback.
    try { if (!state.archiveOpen) await refresh(); } catch (_) { /* retry next tick */ }
    schedulePoll();
  }, sseCovered() ? 15000 : 3000);
}

refresh();
initSSE();
schedulePoll();
