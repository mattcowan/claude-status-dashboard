'use strict';

// Derive a clickable web URL for a project's git remote (origin), so each card
// can link straight to its repo. Reads local git config only (no network, so no
// SSH passphrase prompt). Results are cached per path for the server's lifetime.

const { execFileSync, execFile } = require('child_process');

const cache = new Map(); // projectPath -> url|null

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

function webUrl(projectPath) {
  if (!projectPath) return null;
  if (cache.has(projectPath)) return cache.get(projectPath);
  let url = null;
  try {
    const out = execFileSync('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
      windowsHide: true,
    });
    url = toWebUrl(out.trim());
  } catch (_) {
    url = null; // not a repo, no origin, or git unavailable
  }
  cache.set(projectPath, url);
  return url;
}

// Async variant for the startup backfill: same lookup and cache, but does not
// block the event loop (the sync version can stall up to 2.5s per project).
function webUrlAsync(projectPath) {
  if (!projectPath) return Promise.resolve(null);
  if (cache.has(projectPath)) return Promise.resolve(cache.get(projectPath));
  return new Promise((resolve) => {
    execFile('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    }, (err, stdout) => {
      const url = err ? null : toWebUrl(String(stdout).trim());
      cache.set(projectPath, url);
      resolve(url);
    });
  });
}

module.exports = { webUrl, webUrlAsync, toWebUrl };
