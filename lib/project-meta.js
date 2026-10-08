'use strict';

// Validation for the per-project edits the Projects view writes: a display
// name, a repository link, other links, search keywords and a note. Kept apart
// from lib/store.js as pure functions, for the same reason lib/origin.js is:
// the rules decide what a browser is allowed to persist, so they must be
// testable without a Store or a port.
//
// The name and the repository link are OVERRIDES of something the dashboard
// otherwise works out for itself (the label from the folder name, the link from
// `git remote`), so an empty value is never stored as "" — it removes the
// override and lets the detected value show again. That is also how the edit
// dialog offers "go back to automatic": clear the box. The other three fields
// have no detected value; empty simply means none.

const { toWebUrl } = require('./repo');

const MAX_LABEL = 80;
const MAX_URL = 500;
const MAX_KEYWORD = 40;
const MAX_KEYWORDS = 20;
const MAX_LINKS = 10;
const MAX_LINK_LABEL = 40;
const MAX_NOTE = 2000;

// One collapsed, trimmed line. A name or keyword with an embedded newline would
// render as one thing and search as another.
function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Every stored link is written into an href, so the scheme is the part that
// matters: http(s) only, which shuts out javascript:, data: and file:.
// Credentials are refused rather than stripped: a URL carrying a token is a
// mistake the user should see, not one to quietly save half of. `what` names
// the field in the message, so the dialog can say which box is wrong.
function cleanHttpUrl(s, what) {
  if (s.length > MAX_URL) return { error: what + ' is too long.' };
  let u;
  try { u = new URL(s); } catch (_) { return { error: what + ' is not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: what + ' must start with http:// or https://.' };
  }
  if (u.username || u.password) {
    return { error: 'Remove the user name or token from ' + what.toLowerCase() + '.' };
  }
  return { value: u.href };
}

// A pasted git remote (git@host:owner/repo.git) is accepted and converted by
// the same toWebUrl() the automatic lookup uses, so the user can paste what
// `git remote -v` prints.
function cleanRepoUrl(raw) {
  const s = String(raw).trim();
  if (!s) return { value: null };
  if (/^https?:\/\//i.test(s)) {
    const r = cleanHttpUrl(s, 'The repository link');
    if (r.error) return r;
    return { value: r.value.replace(/\.git$/, '').replace(/\/$/, '') };
  }
  const converted = toWebUrl(s);
  if (!converted) {
    return { error: 'Use an http or https repository link, or a git remote such as git@github.com:owner/repo.git.' };
  }
  return cleanHttpUrl(converted, 'The repository link');
}

// The repeating "Other links" field: [{ label, url }]. A row with both boxes
// empty is a row the user added and never filled, so it is dropped rather than
// refused. A label with no URL is refused — dropping it would lose what was
// typed. Messages start "Link N" (1-based, counting the rows as sent) so the
// dialog can put focus on the row they are about.
function cleanLinks(raw) {
  if (!Array.isArray(raw)) return { error: 'Links must be a list.' };
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const n = 'Link ' + (i + 1);
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: n + ' is not valid.' };
    const label = item.label == null ? '' : item.label;
    const url = item.url == null ? '' : item.url;
    if (typeof label !== 'string' || typeof url !== 'string') return { error: n + ' is not valid.' };
    const l = oneLine(label);
    const u = url.trim();
    if (!l && !u) continue;
    if (!u) return { error: n + ' needs a URL.' };
    if (l.length > MAX_LINK_LABEL) {
      return { error: n + ': the label is longer than ' + MAX_LINK_LABEL + ' characters.' };
    }
    const r = cleanHttpUrl(u, n);
    if (r.error) return r;
    out.push(l ? { label: l, url: r.value } : { url: r.value });
  }
  if (out.length > MAX_LINKS) return { error: 'Use ' + MAX_LINKS + ' links or fewer.' };
  return { value: out.length ? out : null };
}

// Accepts an array or one comma-separated string (what a text box sends).
// Order is kept as typed; duplicates fold case-insensitively, first spelling
// wins.
function cleanKeywords(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (typeof p !== 'string') return { error: 'Keywords must be text.' };
    const k = oneLine(p);
    if (!k) continue;
    if (k.length > MAX_KEYWORD) {
      return { error: 'Keyword “' + k.slice(0, 20) + '…” is longer than ' + MAX_KEYWORD + ' characters.' };
    }
    const fold = k.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(k);
  }
  if (out.length > MAX_KEYWORDS) return { error: 'Use ' + MAX_KEYWORDS + ' keywords or fewer.' };
  return { value: out.length ? out : null };
}

function cleanLabel(raw) {
  const s = oneLine(raw);
  if (!s) return { value: null };
  if (s.length > MAX_LABEL) return { error: 'The name is longer than ' + MAX_LABEL + ' characters.' };
  return { value: s };
}

// The one multi-line field. Line breaks are kept (the row renders them), but
// CRLF folds to LF so a note typed on Windows and one pasted from elsewhere
// count and compare the same, and trailing space on each line goes.
function cleanNote(raw) {
  const s = String(raw).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!s) return { value: null };
  if (s.length > MAX_NOTE) return { error: 'The note is longer than ' + MAX_NOTE + ' characters.' };
  return { value: s };
}

// Each field's cleaner, and the shapes a request may send for it. Checked
// before the cleaner runs, so String() never turns an object into
// "[object Object]" and saves it.
const FIELDS = {
  label: { clean: cleanLabel, shape: (v) => typeof v === 'string' },
  repoUrl: { clean: cleanRepoUrl, shape: (v) => typeof v === 'string' },
  links: { clean: cleanLinks, shape: (v) => Array.isArray(v) },
  keywords: { clean: cleanKeywords, shape: (v) => typeof v === 'string' || Array.isArray(v) },
  note: { clean: cleanNote, shape: (v) => typeof v === 'string' },
};

// Apply `patch` over `current` (both plain objects, `current` may be null).
// Patch semantics: only the keys present in `patch` change, so a client that
// knows about two fields cannot wipe a third. Unknown keys are ignored.
// Returns { meta } — null when no edit is left — or { error }.
function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object') return { error: 'Nothing to save.' };
  const next = Object.assign({}, current || {});
  delete next.updatedAt;
  for (const key of Object.keys(FIELDS)) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (raw !== null && raw !== undefined && !FIELDS[key].shape(raw)) {
      return { error: 'Invalid value for ' + key + '.' };
    }
    const r = raw === null || raw === undefined ? { value: null } : FIELDS[key].clean(raw);
    if (r.error) return { error: r.error };
    if (r.value === null) delete next[key];
    else next[key] = r.value;
  }
  // Drop anything that is not one of ours, so a hand-edited file cannot ride a
  // later save back out to the UI.
  for (const key of Object.keys(next)) {
    if (!(key in FIELDS)) delete next[key];
  }
  return { meta: Object.keys(next).length ? next : null };
}

module.exports = {
  applyPatch, cleanRepoUrl, cleanLinks, cleanKeywords, cleanLabel, cleanNote,
  MAX_KEYWORDS, MAX_KEYWORD, MAX_LABEL, MAX_LINKS, MAX_NOTE,
};
