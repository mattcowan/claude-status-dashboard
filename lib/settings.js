'use strict';

// Server-side settings, persisted to their own data/settings.json (kept out of
// board.json on purpose: board saves are debounced and reset-on-corrupt, and a
// settings blob shouldn't ride along with card churn).

const path = require('path');

const { DATA_DIR, atomicWrite, readJsonSafe } = require('./store');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  usagePoll: {
    enabled: false,       // background polling of the usage endpoint is opt-in
    intervalMs: 600000,   // 10 min
  },
};

// Background poll can't go below the usage module's own fetch throttle.
const MIN_POLL_MS = 5 * 60 * 1000;

let settings = load();

function load() {
  const raw = readJsonSafe(SETTINGS_FILE, {});
  return merge(DEFAULTS, raw);
}

// Whitelist-merge: only keys present in DEFAULTS are honored, so a hand-edited
// or stale file can't inject arbitrary state.
function merge(defaults, incoming) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const val = incoming ? incoming[key] : undefined;
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = merge(def, val);
    } else if (typeof val === typeof def && val !== undefined) {
      out[key] = val;
    } else {
      out[key] = def;
    }
  }
  return out;
}

function getSettings() {
  return settings;
}

function updateSettings(patch) {
  settings = merge(DEFAULTS, Object.assign({}, flatten(settings, patch)));
  if (settings.usagePoll.intervalMs < MIN_POLL_MS) settings.usagePoll.intervalMs = MIN_POLL_MS;
  try { atomicWrite(SETTINGS_FILE, settings); } catch (_) { /* best effort */ }
  return settings;
}

// Shallow-merge a patch over current settings one level deep, so a POST like
// {usagePoll: {enabled: true}} doesn't wipe intervalMs.
function flatten(current, patch) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const def = DEFAULTS[key];
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = Object.assign({}, current[key], patch && patch[key]);
    } else {
      out[key] = patch && key in patch ? patch[key] : current[key];
    }
  }
  return out;
}

module.exports = { getSettings, updateSettings, MIN_POLL_MS };
