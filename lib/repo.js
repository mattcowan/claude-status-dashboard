'use strict';

// Derive a clickable web URL for a project's git remote (origin), so each card
// can link straight to its repo. Reads local git config only (no network, so no
// SSH passphrase prompt).
//
// Results are cached per path, but only for MAX_AGE_MS. The cache used to live
// for the server's whole lifetime, and together with a card saving its link
// once at creation that froze a wrong link in place: a folder whose origin
// changed kept serving the old link to every new card until a restart, and an
// old card that had saved it won the Projects row back whenever it was resumed
// (issue #29). A short expiry keeps the point of the cache — a burst of hooks
// and `status.js` calls from one session costs one `git` spawn, not ten —
// without making a changed remote invisible.

const { execFileSync, execFile } = require('child_process');

const MAX_AGE_MS = 30 * 1000;

const cache = new Map();    // projectPath -> { url: string|null, at: ms }
const inflight = new Map(); // projectPath -> Promise<string|null>, async reads only

// Convert any common remote form to an https web URL, or null if unrecognized.
//   git@github.com:owner/repo.git        -> https://github.com/owner/repo
//   ssh://git@github.com/owner/repo.git  -> https://github.com/owner/repo
//   https://github.com/owner/repo.git    -> https://github.com/owner/repo
//   git://github.com/owner/repo.git      -> https://github.com/owner/repo
function toWebUrl(remote) {
  if (!remote) return null;
  let r = String(remote).trim().replace(/\.git$/, '').replace(/\/$/, '');

  let m = r.match(/^[\w.+-]+@([\w.-]+):(.+)$/); // scp-like (git@host:path)
  if (m) return 'https://' + m[1] + '/' + m[2];

  m = r.match(/^ssh:\/\/(?:[\w.+-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/);
  if (m) return 'https://' + m[1] + '/' + m[2];

  m = r.match(/^git:\/\/([\w.-]+)\/(.+)$/);
  if (m) return 'https://' + m[1] + '/' + m[2];

  m = r.match(/^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/);
  if (m) return 'https://' + m[1] + '/' + m[2];

  return null;
}

// The cached link if it is younger than `maxAge`, else undefined (a cached
// null — "no remote" — is a real answer and is returned as null).
function fresh(projectPath, maxAge) {
  const hit = cache.get(projectPath);
  if (hit && Date.now() - hit.at < maxAge) return hit.url;
  return undefined;
}

const GIT_ARGS = (projectPath) => ['-C', projectPath, 'config', '--get', 'remote.origin.url'];

// Synchronous lookup, for the POST that creates a card: the link goes into the
// card in the same response. Blocks for one `git` spawn on a cache miss (up to
// the 2.5 s timeout, normally a few tens of ms). `maxAge` is for tests.
function webUrl(projectPath, maxAge) {
  if (!projectPath) return null;
  const age = maxAge == null ? MAX_AGE_MS : maxAge;
  const hit = fresh(projectPath, age);
  if (hit !== undefined) return hit;
  let url = null;
  try {
    const out = execFileSync('git', GIT_ARGS(projectPath), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
      windowsHide: true,
    });
    url = toWebUrl(out.trim());
  } catch (_) {
    url = null; // not a repo, no origin, or git unavailable
  }
  cache.set(projectPath, { url: url, at: Date.now() });
  return url;
}

// Async variant: same lookup and cache, but does not block the event loop. Used
// by the startup backfill and by the refresh that runs when a session resumes,
// neither of which has a response waiting on it. Concurrent calls for one path
// share a single `git` spawn.
function webUrlAsync(projectPath, maxAge) {
  if (!projectPath) return Promise.resolve(null);
  const age = maxAge == null ? MAX_AGE_MS : maxAge;
  const hit = fresh(projectPath, age);
  if (hit !== undefined) return Promise.resolve(hit);
  if (inflight.has(projectPath)) return inflight.get(projectPath);
  const p = new Promise((resolve) => {
    execFile('git', GIT_ARGS(projectPath), {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    }, (err, stdout) => {
      const url = err ? null : toWebUrl(String(stdout).trim());
      cache.set(projectPath, { url: url, at: Date.now() });
      inflight.delete(projectPath);
      resolve(url);
    });
  });
  inflight.set(projectPath, p);
  return p;
}

module.exports = { webUrl, webUrlAsync, toWebUrl, MAX_AGE_MS };
