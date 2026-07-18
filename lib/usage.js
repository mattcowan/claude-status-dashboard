'use strict';

// Claude subscription usage limits (5-hour / weekly / per-model buckets).
//
// CAVEAT: there is no official API for subscription usage. This reads the same
// undocumented OAuth endpoint the Claude Code /usage command family relies on
// (community-documented; used by tools like CodexBar / claude-monitor). It can
// change or disappear without notice, so everything here is defensive: the
// normalizer is shape-tolerant, surprises dump the raw response to
// data/usage-last-raw.json for recalibration, and no failure in this module
// may ever crash the server.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { DATA_DIR, atomicWrite, readJsonSafe } = require('./store');

// Env override exists purely so the auth-failure path can be tested with a
// fake credentials file.
const CRED_FILE = process.env.CLAUDE_CRED_FILE ||
  path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const RAW_FILE = path.join(DATA_DIR, 'usage-last-raw.json');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

const MIN_INTERVAL_MS = 5 * 60 * 1000; // opportunistic (hook-triggered) fetches
const MANUAL_MIN_MS = 30 * 1000;       // manual refresh button floor
const FETCH_TIMEOUT_MS = 10 * 1000;

const AUTH_MESSAGE = 'token expired — open a Claude Code session to refresh it';

// status: 'never' | 'ok' | 'auth' | 'error' | 'shape'
let snapshot = readJsonSafe(USAGE_FILE, null) ||
  { fetchedAt: null, ok: false, status: 'never', buckets: [], error: null, stale: false };
let inFlight = null;
let lastAttemptAt = 0;

// Friendly labels for the bucket keys Anthropic has used so far; anything
// unknown falls back to a prettified raw key, so new buckets appear on their
// own when the definitions change.
const LABELS = {
  five_hour: '5-hour session',
  seven_day: 'Weekly (all models)',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_fable: 'Weekly (Fable)',
  seven_day_oauth_apps: 'Weekly (apps)',
};
const LABEL_ORDER = Object.keys(LABELS);

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Length of a bucket's window, inferred from its kind/group/key. Used client-
// side to draw the "even-pace" marker (window start = resetsAt - windowMs).
// The API doesn't state the window length, so this maps the known limit types;
// an unrecognized bucket returns null and simply gets no pace marker.
function windowMsFor(key, group) {
  const k = String(key || '').toLowerCase();
  const g = String(group || '').toLowerCase();
  if (g === 'session' || k === 'session' || /five_hour|(^|[^\d])5h/.test(k)) return FIVE_HOURS_MS;
  if (g === 'weekly' || /weekly|seven_day|(^|[^\d])7d/.test(k)) return SEVEN_DAYS_MS;
  return null;
}

function prettyKey(key) {
  const s = String(key).replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Bucket';
}

function toIso(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number' && isFinite(value)) {
    // Epoch seconds vs milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function firstNumber(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === 'number' && isFinite(obj[k])) return obj[k];
  }
  return null;
}

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return null;
}

// Tolerant normalizer: turns whatever the endpoint returns into
// [{key, label, pct, resetsAt}]. Exported for direct unit testing.
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return [];

  // Preferred shape (observed live 2026-07-17): a top-level `limits` array of
  // {kind, group, percent, severity, resets_at, is_active, scope}, where a
  // weekly_scoped entry names its model via scope.model.display_name — that's
  // how per-model buckets (Opus/Fable/…) arrive dynamically.
  if (Array.isArray(raw.limits)) {
    const buckets = [];
    for (const lim of raw.limits) {
      if (!lim || typeof lim !== 'object') continue;
      const pct = (typeof lim.percent === 'number' && isFinite(lim.percent))
        ? Math.max(0, Math.min(100, Math.round(lim.percent * 10) / 10))
        : null;
      const resetsAt = toIso(firstDefined(lim, ['resets_at', 'resetsAt', 'reset_at']));
      if (pct === null && !resetsAt) continue;
      const modelName = lim.scope && lim.scope.model && lim.scope.model.display_name;
      const kind = String(lim.kind || 'limit');
      let label;
      if (kind === 'session') label = '5-hour session';
      else if (kind === 'weekly_all') label = 'Weekly (all models)';
      else if (kind === 'weekly_scoped') label = 'Weekly (' + (modelName || 'scoped') + ')';
      else label = prettyKey(kind) + (modelName ? ' (' + modelName + ')' : '');
      buckets.push({
        key: modelName ? kind + ':' + modelName : kind,
        label: label,
        pct: pct,
        resetsAt: resetsAt,
        severity: lim.severity || null,
        windowMs: windowMsFor(kind, lim.group),
      });
    }
    if (buckets.length) return buckets; // API order is already session → weekly
  }

  // Fallback: older/other shapes — an object map like {five_hour: {utilization,
  // resets_at}, …} or a bare array, possibly wrapped in an envelope.
  let root = raw;
  for (const wrap of ['usage', 'data']) {
    if (root[wrap] && typeof root[wrap] === 'object') { root = root[wrap]; break; }
  }

  // Candidates: array entries, or object values keyed by bucket name.
  let candidates = [];
  if (Array.isArray(root)) {
    candidates = root.map((entry, i) => ({
      key: (entry && (entry.type || entry.name || entry.key || entry.kind)) || 'bucket_' + i,
      val: entry,
    }));
  } else {
    candidates = Object.entries(root)
      .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
      .map(([key, val]) => ({ key, val }));
  }

  const buckets = [];
  for (const { key, val } of candidates) {
    if (!val || typeof val !== 'object') continue;
    const util = firstNumber(val, ['utilization', 'percent', 'used_pct', 'percent_used', 'percentage']);
    const used = firstNumber(val, ['used']);
    const limit = firstNumber(val, ['limit']);
    const reset = firstDefined(val, ['resets_at', 'resetsAt', 'reset_at', 'resets']);
    const isBucket = util !== null || (used !== null && limit !== null) || reset !== null;
    if (!isBucket) continue;

    let pct = null;
    if (util !== null) pct = util;
    else if (used !== null && limit) pct = (used / limit) * 100;
    buckets.push({ key: String(key), pct, resetsAt: toIso(reset) });
  }

  // Utilization is sometimes a 0-1 fraction: if every value fits in 0..1,
  // read them as fractions.
  const pcts = buckets.map((b) => b.pct).filter((p) => p !== null);
  if (pcts.length && pcts.every((p) => p >= 0 && p <= 1)) {
    for (const b of buckets) { if (b.pct !== null) b.pct = b.pct * 100; }
  }
  for (const b of buckets) {
    if (b.pct !== null) b.pct = Math.max(0, Math.min(100, Math.round(b.pct * 10) / 10));
    b.label = LABELS[b.key] || prettyKey(b.key);
    b.windowMs = windowMsFor(b.key);
  }

  // Known buckets first, in a stable order; unknown ones after.
  buckets.sort((a, b) => {
    const ai = LABEL_ORDER.indexOf(a.key); const bi = LABEL_ORDER.indexOf(b.key);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.key.localeCompare(b.key);
  });
  return buckets;
}

// Read the OAuth token fresh each time — Claude Code rotates it in place.
function readToken() {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const oauth = creds && creds.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
    return { token: oauth.accessToken, expiresAt: oauth.expiresAt || null };
  } catch (_) {
    return null;
  }
}

function persist() {
  try { atomicWrite(USAGE_FILE, snapshot); } catch (_) { /* best effort */ }
}

function setFailure(status, message) {
  // Keep the last known buckets around, but mark them stale.
  snapshot = Object.assign({}, snapshot, {
    ok: false,
    status: status,
    error: message,
    stale: !!(snapshot.buckets && snapshot.buckets.length),
  });
  persist();
}

// Fetch the usage snapshot. Never rejects; always resolves to the current
// snapshot. Throttled (5 min opportunistic, 30s manual) and deduped.
async function fetchUsage(opts) {
  const manual = !!(opts && opts.manual);
  try {
    if (inFlight) return await inFlight;
    const minGap = manual ? MANUAL_MIN_MS : MIN_INTERVAL_MS;
    if (lastAttemptAt && Date.now() - lastAttemptAt < minGap) {
      return Object.assign({}, snapshot, { throttled: true });
    }
    lastAttemptAt = Date.now();
    inFlight = doFetch();
    return await inFlight;
  } catch (_) {
    return snapshot; // belt and braces — doFetch already catches everything
  } finally {
    inFlight = null;
  }
}

async function doFetch() {
  try {
    const cred = readToken();
    if (!cred) {
      setFailure('auth', AUTH_MESSAGE);
      return snapshot;
    }
    // A stale-looking expiresAt can lag reality; attempt anyway and let a 401
    // be the arbiter.
    let res;
    try {
      res = await fetch(USAGE_URL, {
        headers: {
          Authorization: 'Bearer ' + cred.token,
          'anthropic-beta': OAUTH_BETA,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      setFailure('error', 'usage fetch failed: ' + (err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message) || 'network error'));
      return snapshot;
    }

    if (res.status === 401 || res.status === 403) {
      setFailure('auth', AUTH_MESSAGE);
      return snapshot;
    }
    if (!res.ok) {
      setFailure('error', 'usage endpoint answered HTTP ' + res.status);
      return snapshot;
    }

    let json;
    try { json = await res.json(); } catch (_) {
      setFailure('error', 'usage endpoint returned non-JSON');
      return snapshot;
    }

    const buckets = normalizeUsage(json);
    if (!buckets.length) {
      // Shape surprise: keep the raw response on disk so the normalizer can be
      // recalibrated against reality instead of guesses.
      try { atomicWrite(RAW_FILE, json); } catch (_) { /* best effort */ }
      setFailure('shape', 'unexpected response shape — raw saved to data/usage-last-raw.json');
      return snapshot;
    }

    snapshot = {
      fetchedAt: new Date().toISOString(),
      ok: true,
      status: 'ok',
      buckets: buckets,
      error: null,
      stale: false,
    };
    persist();
    return snapshot;
  } catch (err) {
    // Absolutely nothing in here may take the server down.
    setFailure('error', 'usage module error: ' + ((err && err.message) || 'unknown'));
    return snapshot;
  }
}

// Fire-and-forget wrapper for hook endpoints.
function maybeRefresh() {
  fetchUsage().catch(() => {});
}

function getSnapshot() {
  return snapshot;
}

module.exports = { fetchUsage, maybeRefresh, getSnapshot, normalizeUsage, MIN_INTERVAL_MS };
