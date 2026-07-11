'use strict';

// Claude Session Status Dashboard — local server.
// Zero external dependencies: node:http, node:fs, node:path, node:url only.
// Serves the Kanban UI (public/) and a small JSON REST API. A single instance
// owns data/board.json, so concurrent writes from many sessions are serialized.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const config = require('./lib/config');
const { Store } = require('./lib/store');

const VERSION = '1.0.0';
const store = new Store();

const PUBLIC_DIR = path.join(config.ROOT, 'public');
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

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/\\/g, '/');
  // Prevent path traversal.
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
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

  // Session upsert (SessionStart hook)
  if (method === 'POST' && pathname === '/api/cards') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    const card = store.upsertSession(body.session, body.project, body.source);
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
    const card = store.applyStopBackstop(body.session, body.leftOff || '');
    return sendJson(res, 200, { card });
  }

  // Session end (SessionEnd hook)
  if (method === 'POST' && pathname === '/api/hook/session-end') {
    const body = await readBody(req);
    if (!body.session) return sendJson(res, 400, { error: 'session required' });
    const card = store.markSessionEnded(body.session);
    return sendJson(res, 200, { card });
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
    const key = decodeURIComponent(cm[1]);
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
    const id = decodeURIComponent(m[1]);
    const action = m[2] || null;

    if (method === 'POST' && !action) {
      const body = await readBody(req);
      const card = store.updateCard(id, body);
      if (!card) return sendJson(res, 404, { error: 'card not found' });
      return sendJson(res, 200, { card });
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

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.query).catch((err) => {
      sendJson(res, 500, { error: err.message });
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
});

function shutdown() {
  try { store.flushSync(); } catch (_) { /* ignore */ }
  try { server.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
