'use strict';

// The gate on every write the API accepts.
//
// The API has no auth — it is a loopback board — so two request headers are all
// that stands between it and a page on another origin. Neither is forgeable by
// the attacker that matters here:
//
//   Origin  A browser stamps this on a cross-origin request itself; script
//           cannot set or remove it. A caller that is not a browser sends none
//           at all, which is how the CLI and the hooks get through.
//   Host    Defends the DNS-rebinding case, where a page on evil.com resolves
//           that name to 127.0.0.1 and so IS same-origin by the browser's
//           reckoning. Its Origin then looks fine; its Host still says
//           evil.com.
//
// Both must pass, and they are checked for every request that is not a GET.
// This used to guard only the open-folder endpoint, on the reasoning that
// launching a process deserved more care than "mutating board data" — but the
// data endpoints include DELETE /api/cards/:id and /api/archive-done, and a
// cross-origin form POST reaches those with no preflight at all: a "simple
// request" with Content-Type: text/plain still parses as JSON on the way in.
// Losing a card is not less bad than opening a folder.
//
// It lives in its own module so the decision can be tested without starting a
// server — server.js binds a port at import, and the data store writes to a
// fixed directory, so there is no way to exercise the real HTTP path against a
// throwaway board.

const config = require('./config');

// Is this request's Origin one of ours? An absent Origin means a non-browser
// caller (the CLI, the hooks, curl); the Host check still applies to it.
//
// Deliberately an exact string match against the two origins this server can be
// reached on, not a prefix or a substring test: "http://127.0.0.1.evil.com" and
// "http://evil.com#http://127.0.0.1:4787" both contain a trusted origin and
// neither is one. The literal string "null" — what a sandboxed iframe or some
// cross-site redirects send — is a value, not an absence, so it falls through
// to the comparison and is refused.
function isTrustedOrigin(req, port) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin === undefined) return true;
  const p = port === undefined ? config.resolvePort() : port;
  return origin === 'http://127.0.0.1:' + p || origin === 'http://localhost:' + p;
}

// Is the Host header one of ours? Strips the port, and the brackets an IPv6
// literal arrives in ("[::1]:4787" -> "::1").
//
// Compared case-sensitively, so "LOCALHOST" is refused. Host is nominally
// case-insensitive, but every browser lowercases it, so the only caller this
// can turn away is a hand-written one — and being refused is the safe way for
// that to go wrong.
function isLoopbackHost(req) {
  const raw = req && req.headers ? req.headers.host : '';
  const host = String(raw || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// The gate itself: both checks, for anything that writes.
function allowsWrite(req, port) {
  return isTrustedOrigin(req, port) && isLoopbackHost(req);
}

// What the router asks. Reads are open — they leak nothing a local page cannot
// already see, and the board is fetched by the dashboard on a timer — while
// everything else has to come from a trusted origin on a loopback host.
//
// The whole decision lives here rather than at each route so that a new write
// endpoint is covered the day it is added rather than the day someone
// remembers, which is how the gap this closes came about.
function allowsRequest(method, req, port) {
  if (method === 'GET') return true;
  return allowsWrite(req, port);
}

module.exports = {
  isTrustedOrigin: isTrustedOrigin,
  isLoopbackHost: isLoopbackHost,
  allowsWrite: allowsWrite,
  allowsRequest: allowsRequest,
};
