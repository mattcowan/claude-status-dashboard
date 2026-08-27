'use strict';

// Tests for the write gate (lib/origin.js).
//
// This is the one part of the server with an attacker in its threat model, and
// it was added in response to a real hole: while the dashboard is running, a
// page on any other origin could POST to it. There is no OPTIONS handler, so a
// cross-origin JSON POST cannot preflight — but it does not need to. A
// form-shaped "simple request" with Content-Type: text/plain skips preflight
// altogether and its body still parses as JSON on the way in, which reached
// DELETE /api/cards/:id and /api/archive-done among others.
//
// The gate is a pure function of two request headers, which is why it lives in
// its own module: server.js binds a port at import and lib/store.js writes to a
// fixed data directory, so the real HTTP path cannot be exercised against a
// throwaway board. Everything below is the decision itself, not the transport.
//
// A port is passed explicitly throughout so nothing depends on this machine's
// data/server.port or a PORT environment variable.

const test = require('node:test');
const assert = require('node:assert');

const origin = require('../lib/origin');

const PORT = 4787;
const HOST = '127.0.0.1:' + PORT;

// A request is only ever these two headers as far as the gate is concerned.
// `origin: undefined` means the header was absent; pass it explicitly to mean
// a header that arrived with an odd value.
function req(headers) {
  return { headers: headers || {} };
}

// ---------- the hole this closes ----------

test('a cross-origin page cannot write', () => {
  assert.equal(
    origin.allowsWrite(req({ origin: 'https://evil.example', host: HOST }), PORT),
    false,
    'the motivating case: another origin POSTing to the loopback board'
  );
});

test('reads stay open, writes do not', () => {
  const hostile = req({ origin: 'https://evil.example', host: HOST });
  assert.equal(origin.allowsRequest('GET', hostile, PORT), true,
    'GET is exempt — the board is fetched on a timer and leaks nothing local script cannot already see');
  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
    assert.equal(origin.allowsRequest(method, hostile, PORT), false,
      method + ' must be gated');
  }
});

test('the gate is on the method, not on a list of routes', () => {
  // HEAD is a read but is not GET, so it is gated. That is intentional: the
  // router matches 'GET' exactly, so a HEAD reaches no endpoint anyway, and
  // an allowlist of "read-ish" methods is exactly the kind of thing that goes
  // stale. Anything new and unrecognized should be refused, not waved through.
  const hostile = req({ origin: 'https://evil.example', host: HOST });
  assert.equal(origin.allowsRequest('HEAD', hostile, PORT), false);
  assert.equal(origin.allowsRequest('WIDGET', hostile, PORT), false);
});

// ---------- the two callers that must keep working ----------

test('the CLI and the hooks get through (no Origin header at all)', () => {
  // bin/status.js uses http.request, which sends no Origin. If this ever fails,
  // every hook silently stops updating the board.
  assert.equal(origin.allowsWrite(req({ host: HOST }), PORT), true);
  assert.equal(origin.allowsRequest('POST', req({ host: HOST }), PORT), true);
});

test('the dashboard page itself gets through, on either spelling', () => {
  for (const o of ['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT]) {
    assert.equal(origin.allowsWrite(req({ origin: o, host: HOST }), PORT), true, o);
  }
});

test('every loopback Host spelling is accepted', () => {
  const hosts = ['127.0.0.1:' + PORT, '127.0.0.1', 'localhost:' + PORT, 'localhost',
    '[::1]:' + PORT, '[::1]'];
  for (const host of hosts) {
    assert.equal(origin.isLoopbackHost(req({ host: host })), true, host);
  }
});

// ---------- DNS rebinding: the reason Host is checked at all ----------

test('a trusted-looking Origin on a foreign Host is refused', () => {
  // A page on evil.com that resolves that name to 127.0.0.1 IS same-origin by
  // the browser's reckoning, so its Origin looks perfect. The Host header is
  // what still says evil.com. Origin alone would let this through.
  const rebound = req({ origin: 'http://127.0.0.1:' + PORT, host: 'evil.example' });
  assert.equal(origin.isTrustedOrigin(rebound, PORT), true, 'Origin alone is satisfied');
  assert.equal(origin.isLoopbackHost(rebound), false, 'Host is what catches it');
  assert.equal(origin.allowsWrite(rebound, PORT), false, 'so the gate refuses it');
});

test('a missing Host is refused', () => {
  // HTTP/1.1 requires Host, so its absence is not a caller worth trusting.
  assert.equal(origin.isLoopbackHost(req({})), false);
  assert.equal(origin.allowsWrite(req({}), PORT), false,
    'no Origin AND no Host must not add up to trusted');
});

// ---------- near misses, which is where a check like this usually fails ----------

test('an Origin that merely contains a trusted one is refused', () => {
  const nearMisses = [
    'http://127.0.0.1.evil.example:' + PORT,   // trusted origin as a domain prefix
    'http://evil.example#http://127.0.0.1:' + PORT,
    'http://evil.example/http://localhost:' + PORT,
    'http://localhost.evil.example:' + PORT,
    'http://127.0.0.1:' + PORT + '.evil.example',
  ];
  for (const o of nearMisses) {
    assert.equal(origin.isTrustedOrigin(req({ origin: o }), PORT), false, o);
  }
});

test('scheme and port must match exactly', () => {
  const wrong = [
    'https://127.0.0.1:' + PORT,          // the dashboard is http; https is a different origin
    'http://127.0.0.1:' + (PORT + 1),     // a different local server
    'http://127.0.0.1',                   // no port at all
    'http://127.0.0.2:' + PORT,           // loopback range, but not our address
    'file://',
  ];
  for (const o of wrong) {
    assert.equal(origin.isTrustedOrigin(req({ origin: o }), PORT), false, o);
  }
});

test('an Origin of "null" is a value, not an absence', () => {
  // Sandboxed iframes and some cross-site redirects send the literal string
  // "null". Treating it like a missing header — which is what the CLI relies on
  // — would hand those callers a write.
  assert.equal(origin.isTrustedOrigin(req({ origin: 'null' }), PORT), false);
  assert.equal(origin.isTrustedOrigin(req({ origin: '' }), PORT), false,
    'an empty Origin is likewise not an absent one');
  assert.equal(origin.isTrustedOrigin(req({ origin: undefined }), PORT), true,
    'only a genuinely absent header means "not a browser"');
});

test('a Host that merely contains a loopback name is refused', () => {
  for (const host of ['127.0.0.1.evil.example', 'evil.example', 'localhost.evil.example',
    'notlocalhost', 'evil.example:' + PORT]) {
    assert.equal(origin.isLoopbackHost(req({ host: host })), false, host);
  }
});

test('comparison is case-sensitive, and that fails closed', () => {
  // Host is nominally case-insensitive, but browsers lowercase it, so the only
  // caller this can turn away is a hand-written one — and refusing is the safe
  // direction for that to go. Pinned so that relaxing it is a deliberate act
  // rather than a passing thought.
  assert.equal(origin.isLoopbackHost(req({ host: 'LOCALHOST:' + PORT })), false);
  assert.equal(origin.isTrustedOrigin(req({ origin: 'HTTP://LOCALHOST:' + PORT }), PORT), false);
});

test('a malformed request object does not throw its way past the gate', () => {
  // handleApi is reached from a request handler with no try/catch around this
  // check, so a throw here would be a 500 rather than a 403 — and a crash loop
  // is its own denial of service.
  assert.equal(origin.allowsWrite({}, PORT), false, 'no headers at all');
  assert.equal(origin.allowsWrite({ headers: { host: 123 } }, PORT), false, 'non-string Host');
  assert.equal(origin.allowsWrite(null, PORT), false, 'no request at all');
});

// ---------- the port is read from config when not passed ----------

test('the port defaults to the configured one', () => {
  // server.js calls these with one argument. The explicit-port form used
  // throughout this file must not be the only one that works.
  const configured = require('../lib/config').resolvePort();
  const good = req({ origin: 'http://127.0.0.1:' + configured, host: '127.0.0.1' });
  assert.equal(origin.isTrustedOrigin(good), true);
  assert.equal(origin.allowsWrite(good), true);

  const bad = req({ origin: 'http://127.0.0.1:' + (configured + 1), host: '127.0.0.1' });
  assert.equal(origin.isTrustedOrigin(bad), false);
});
