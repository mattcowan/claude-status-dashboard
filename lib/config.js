'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PORT_FILE = path.join(DATA_DIR, 'server.port');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4787;

function resolvePort() {
  if (process.env.PORT && /^\d+$/.test(process.env.PORT)) {
    return parseInt(process.env.PORT, 10);
  }
  try {
    if (fs.existsSync(PORT_FILE)) {
      const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
      if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    }
  } catch (_) { /* ignore */ }
  return DEFAULT_PORT;
}

module.exports = {
  ROOT: ROOT,
  DATA_DIR: DATA_DIR,
  PORT_FILE: PORT_FILE,
  HOST: HOST,
  DEFAULT_PORT: DEFAULT_PORT,
  resolvePort: resolvePort,
  baseUrl: function () { return 'http://' + HOST + ':' + resolvePort(); },
  serverPath: path.join(ROOT, 'server.js'),
  logFile: path.join(DATA_DIR, 'server.log'),
  pidFile: path.join(DATA_DIR, 'server.pid'),
};
