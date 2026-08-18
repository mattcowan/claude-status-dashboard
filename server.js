'use strict';

// Claude Session Status Dashboard — local server.
// Zero external dependencies: node:http, node:fs, node:path, node:url only.
// Serves the Kanban UI (public/) and a small JSON REST API. A single instance
// owns data/board.json, so concurrent writes from many sessions are serialized.

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');

const config = require('./lib/config');
const { Store } = require('./lib/store');
const repo = require('./lib/repo');
const usage = require('./lib/usage');
const settings = require('./lib/settings');
const skipPrompts = require('./lib/skip-prompts');

const VERSION = require('./package.json').version;
const store = new Store();

const PUBLIC_DIR = path.resolve(config.ROOT, 'public');

// decodeURIComponent throws on malformed %-encoding; return null so callers can
// answer 400 instead of crashing the request (or the process).
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return null; }
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); resolve({}); } // 1MB cap
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// Every other endpoint only reads or mutates board data; open-folder launches a
// process, so it gets a stricter gate. A page on another origin can still POST
// here (the API has no auth), but the browser stamps its own Origin on that
// request, and only our own origins are accepted.
function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser caller (CLI/curl); host check below still applies
  const port = config.resolvePort();
  return origin === 'http://127.0.0.1:' + port || origin === 'http://localhost:' + port;
}

function isLoopbackHost(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// Reveal a directory in the OS file manager. The path always comes from a card
// record — never from the request body — so there is nothing to sanitize beyond
// confirming the directory still exists. execFile with an argv array means no
// shell, so spaces and metacharacters in the path are inert.
function openFolder(res, dir) {
  if (!dir) return sendJson(res, 400, { error: 'no working directory recorded for this session' });
  const target = path.resolve(dir);
  fs.stat(target, (err, stats) => {
    if (err) return sendJson(res, 404, { error: 'folder no longer exists', path: target });
    if (!stats.isDirectory()) return sendJson(res, 400, { error: 'not a folder', path: target });

    const cmd = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [target], (spawnErr) => {
      if (spawnErr) {
        // explorer.exe exits 1 even when it opened the window, so on Windows a
        // non-zero exit says nothing and only a spawn failure counts. open and
        // xdg-open do report failure in their exit code, so there any error is
        // one — reporting success while nothing opened is worse than a message.
        if (process.platform !== 'win32' || spawnErr.code === 'ENOENT') {
          return sendJson(res, 500, { error: 'could not open the folder: ' + spawnErr.message });
        }
      }
      sendJson(res, 200, { ok: true, path: target });
    });
  });
}

function serveStatic(req, res, pathname) {
  const decoded = safeDecode(pathname === '/' ? '/index.html' : pathname);
  if (decoded === null) { res.writeHead(400); res.end('Bad request'); return; }
  const rel = decoded.replace(/\\/g, '/');
  // Prevent path traversal: resolve, then require the result to be PUBLIC_DIR
  // itself or a path beneath it (a path.sep boundary, so "public2" can't match
  // a "public" prefix).
  const target = path.resolve(path.join(PUBLIC_DIR, rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  // GET endpoints
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid });
  }
  if (method === 'GET' && pathname === '/api/board') {
    return sendJson(res, 200, {
      cards: store.listCards(query.project || null),
      columns: store.listColumns(),
    });
  }
  if (method === 'GET' && pathname === '/api/columns') {
    return sendJson(res, 200, { columns: store.listColumns() });
  }
  if (method === 'GET' && pathname === '/api/projects') {
    return sendJson(res, 200, { projects: store.projects() });
  }
  if (method === 'GET' && pathname === '/api/archive') {
    return sendJson(res, 200, { cards: store.listArchive() });
  }

  // Session upsert (first-prompt hook / CLI)
  if (method === 'POST' && pathname === '/api/cards') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    // Read before the upsert: skippedBefore only means something on the POST
    // that actually mints the card. On an existing card it would be reporting a
    // mid-session /git-commit-message, which is routine and not worth flagging.
    const isNew = !store.getCard(body.session);
    // A session whose only prompts so far were skip-listed bookkeeping
    // commands (/git-review, /git-commit-message — see lib/skip-prompts.js)
    // must not get a card just because this POST came from bin/status.js's
    // own set/note/needs-input/done-for-review subcommands rather than the
    // UserPromptSubmit hook. A real prompt always consumes (deletes) the
    // marker before issuing its own card-creating POST, so if the marker is
    // still present here, this request did not originate from real work.
    if (isNew && skipPrompts.hasPendingSkip(body.session)) {
      return sendJson(res, 200, { card: null, suppressed: true });
    }
    const repoUrl = body.project ? repo.webUrl(body.project) : null;
    const card = store.upsertSession(body.session, body.project, body.source, repoUrl, body.model);
    store.setSessionMeta(body.session, body);
    if (isNew && body.skippedBefore) store.noteSkippedBefore(body.session, body.skippedBefore);
    usage.maybeRefresh();
    return sendJson(res, 200, { card });
  }

  // CLI resolve: find the active card for a project path (no explicit session)
  if (method === 'GET' && pathname === '/api/resolve') {
    const card = query.project ? store.resolveByProject(query.project) : null;
    return sendJson(res, 200, { card });
  }

  // Backstop (Stop hook)
  if (method === 'POST' && pathname === '/api/hook/stop') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    // Record the model regardless of column (the backstop only acts on
    // 'working', but a switched model should still be captured everywhere).
    if (body.model) store.setModel(body.session, body.model);
    store.setSessionMeta(body.session, body);
    const card = store.applyStopBackstop(body.session, body.leftOff || '');
    usage.maybeRefresh();
    return sendJson(res, 200, { card });
  }

  // Session end (SessionEnd hook)
  if (method === 'POST' && pathname === '/api/hook/session-end') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    const card = store.markSessionEnded(body.session);
    usage.maybeRefresh();
    return sendJson(res, 200, { card });
  }

  // Usage limits (undocumented endpoint — see lib/usage.js caveats)
  if (method === 'GET' && pathname === '/api/usage') {
    usage.maybeRefresh(); // opportunistic, throttled
    return sendJson(res, 200, usage.getSnapshot());
  }
  if (method === 'POST' && pathname === '/api/usage/refresh') {
    return sendJson(res, 200, await usage.fetchUsage({ manual: true }));
  }

  // Server-side settings
  if (method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, settings.getSettings());
  }
  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(req);
    const merged = settings.updateSettings(body);
    applyUsagePollTimer();
    return sendJson(res, 200, merged);
  }

  // Column management
  if (method === 'POST' && pathname === '/api/columns') {
    const body = await readBody(req);
    const col = store.addColumn(body.label);
    if (!col) return sendJson(res, 400, { error: 'label required' });
    return sendJson(res, 200, { column: col, columns: store.listColumns() });
  }
  const cm = pathname.match(/^\/api\/columns\/([^/]+)(?:\/([^/]+))?$/);
  if (cm) {
    const key = safeDecode(cm[1]);
    if (key === null) return sendJson(res, 400, { error: 'bad url encoding' });
    const action = cm[2] || null;

    if (method === 'POST' && !action) {
      const body = await readBody(req);
      const col = store.renameColumn(key, body.label);
      if (!col) return sendJson(res, 400, { error: 'cannot rename (not a custom column?)' });
      return sendJson(res, 200, { column: col, columns: store.listColumns() });
    }
    if (method === 'POST' && action === 'reorder') {
      const body = await readBody(req);
      const cols = store.moveColumn(key, body.dir === 'left' ? 'left' : 'right');
      if (!cols) return sendJson(res, 400, { error: 'cannot reorder' });
      return sendJson(res, 200, { columns: cols });
    }
    if (method === 'DELETE') {
      const opts = {};
      if (query.archive === '1' || query.archive === 'true') opts.archive = true;
      if (query.reassign) opts.reassignTo = query.reassign;
      const result = store.removeColumn(key, opts);
      if (result.needsChoice) {
        return sendJson(res, 409, { needsChoice: true, count: result.count });
      }
      if (!result.ok) return sendJson(res, 400, { error: result.error || 'delete failed' });
      return sendJson(res, 200, { ok: true, columns: store.listColumns() });
    }
  }

  // Per-card routes: /api/cards/:id[/action]
  const m = pathname.match(/^\/api\/cards\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const id = safeDecode(m[1]);
    if (id === null) return sendJson(res, 400, { error: 'bad url encoding' });
    const action = m[2] || null;

    if (method === 'GET' && action === 'plan') {
      return servePlan(res, id, query);
    }
    if (method === 'POST' && !action) {
      const body = await readBody(req);
      const card = store.updateCard(id, body);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
    }
    if (method === 'POST' && action === 'open-folder') {
      if (!isTrustedOrigin(req) || !isLoopbackHost(req)) {
        return sendJson(res, 403, { error: 'forbidden' });
      }
      const card = store.getCardAnywhere(id);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return openFolder(res, card.project);
    }
    if (method === 'POST' && action === 'move') {
      const body = await readBody(req);
      const card = store.moveCard(id, body.column, body.auto);
      if (!card) return sendJson(res, 404, { error: 'card not found or bad column' });
      return sendJson(res, 200, { card });
    }
    if (method === 'POST' && action === 'external-edit') {
      const body = await readBody(req);
      const card = store.addExternalEdit(id, body.file);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
    }
    if (method === 'POST' && action === 'done') {
      const card = store.moveCard(id, 'done', false);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
    }
    if (method === 'POST' && action === 'restore') {
      const card = store.restoreCard(id);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
    }
    if (method === 'POST' && action === 'archive') {
      const card = store.archiveCard(id);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
    }
    if (method === 'DELETE' && !action) {
      const ok = store.deleteCard(id);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
  }

  if (method === 'POST' && pathname === '/api/archive-done') {
    const count = store.archiveAllDone();
    return sendJson(res, 200, { archived: count });
  }

  return sendJson(res, 404, { error: 'no such endpoint' });
}

// Serve the markdown of the plan file(s) Claude Code wrote for a session
// (~/.claude/plans/<slug>*.md), so the UI can show a card's plan in a modal.
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const MAX_PLAN_BYTES = 5 * 1024 * 1024; // plans are markdown; 5MB is far above real ones

function servePlan(res, id, query) {
  const card = store.getCardAnywhere(id);
  if (!card) return sendJson(res, 404, { error: 'card not found' });
  if (!card.slug) return sendJson(res, 404, { error: 'no plan recorded for this session' });
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(card.slug)) {
    return sendJson(res, 400, { error: 'invalid slug' });
  }
  fs.readdir(PLANS_DIR, (err, entries) => {
    if (err) return sendJson(res, 404, { error: 'no plan file found', slug: card.slug });
    const files = entries
      .filter((f) => f.startsWith(card.slug) && f.endsWith('.md'))
      .sort();
    if (!files.length) return sendJson(res, 404, { error: 'no plan file found', slug: card.slug });

    let name = null;
    if (query.file) {
      // Must be one of the directory entries we just matched — entries contain
      // no path separators, so this alone rules out traversal.
      if (!files.includes(query.file)) return sendJson(res, 400, { error: 'bad file' });
      name = query.file;
    } else {
      name = files.includes(card.slug + '.md') ? card.slug + '.md' : files[0];
    }
    const target = path.resolve(PLANS_DIR, name);
    if (!target.startsWith(PLANS_DIR + path.sep)) {
      return sendJson(res, 400, { error: 'bad file' }); // belt and braces
    }
    // lstat (not stat) so a symlink is seen as itself: isFile() is false for a
    // symlink, directory, device or pipe, so this one check rejects a symlink
    // escaping the plans dir as well as any non-regular file. Then bound the
    // size — the markdown is read whole and JSON-stringified into one response
    // on the single-threaded server, so a huge file would spike memory.
    fs.lstat(target, (statErr, stats) => {
      if (statErr) return sendJson(res, 404, { error: 'plan file unreadable' });
      if (!stats.isFile()) return sendJson(res, 400, { error: 'not a plan file' });
      if (stats.size > MAX_PLAN_BYTES) {
        return sendJson(res, 413, { error: 'plan file too large', bytes: stats.size });
      }
      fs.readFile(target, 'utf8', (readErr, markdown) => {
        if (readErr) return sendJson(res, 404, { error: 'plan file unreadable' });
        sendJson(res, 200, { ok: true, file: name, files: files, markdown: markdown });
      });
    });
  });
}

// ---------- SSE (live board updates) ----------

const sseClients = new Set();

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

function sseBroadcast(payload) {
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

store.on('change', () => sseBroadcast('event: changed\ndata: {}\n\n'));
setInterval(() => sseBroadcast(':hb\n\n'), 25000).unref();

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (req.method === 'GET' && pathname === '/api/events') {
    return handleEvents(req, res); // long-lived stream; never goes via sendJson
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else { try { res.end(); } catch (_) { /* ignore */ } }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

const PORT = config.resolvePort();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another instance already owns the port — that's fine, exit quietly.
    // eslint-disable-next-line no-console
    console.error('[server] port ' + PORT + ' in use; assuming another instance is running.');
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error('[server] error: ' + err.message);
  process.exit(1);
});

server.listen(PORT, config.HOST, () => {
  try { fs.writeFileSync(config.pidFile, String(process.pid)); } catch (_) { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log('[server] Claude status dashboard on ' + config.baseUrl() + ' (pid ' + process.pid + ')');
  // Backfill GitHub/remote links for cards created before this feature
  // existed. Async and sequential, AFTER listen: the sync version could stall
  // startup ~2.5s per project.
  setImmediate(backfillRepoUrls);
  applyUsagePollTimer();
});

async function backfillRepoUrls() {
  for (const card of store.listCards(null)) {
    if (!card.project || card.repoUrl) continue;
    try {
      const link = await repo.webUrlAsync(card.project);
      if (link) store.setRepoUrl(card.id, link);
    } catch (_) { /* best effort */ }
  }
}

// Optional background polling of the usage endpoint — an opt-in setting,
// off by default (the hook-triggered refresh covers active use).
let usagePollTimer = null;
function applyUsagePollTimer() {
  if (usagePollTimer) { clearInterval(usagePollTimer); usagePollTimer = null; }
  const poll = settings.getSettings().usagePoll;
  if (!poll.enabled) return;
  const interval = Math.max(poll.intervalMs, usage.MIN_INTERVAL_MS);
  usagePollTimer = setInterval(usage.maybeRefresh, interval);
  usagePollTimer.unref();
}

function shutdown() {
  try { store.flushSync(); } catch (_) { /* ignore */ }
  for (const res of sseClients) { try { res.end(); } catch (_) { /* ignore */ } }
  try { server.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Last-resort flushes: 'exit' (must stay synchronous) covers plain
// process.exit paths, and an uncaught throw shouldn't lose the debounce
// window. Only flush when a save is actually pending — an instance exiting on
// EADDRINUSE loaded a snapshot another process has since moved past, and an
// unconditional flush would clobber the owner's newer file.
process.on('exit', () => {
  try { if (store.hasPendingSave()) store.flushSync(); } catch (_) { /* ignore */ }
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[server] uncaught: ' + ((err && err.stack) || err));
  try { if (store.hasPendingSave()) store.flushSync(); } catch (_) { /* ignore */ }
  process.exit(1);
});
