# CLAUDE.md

Guidance for Claude Code sessions working in this repository. The
[README](README.md) is the user-facing manual and is deliberately thorough —
read it for *what* a feature does. This file covers what a session needs to
know before changing anything: the architecture, the invariants that are easy
to break silently, and the local conventions.

---

## What this project is

A local Kanban dashboard that tracks **every Claude Code session** across every
project. Cards are created and moved by Claude Code **hooks** plus a small CLI
(`bin/status.js`); a single long-lived Node server owns the data files and
serves the UI at `http://127.0.0.1:4787`.

**You are working on the thing that is watching you.** This repo's own server
is almost certainly running right now, holding the user's live board for all
their other sessions. That has practical consequences, listed under
[Working on a live system](#working-on-a-live-system).

---

## Hard constraints

These are design commitments, not preferences. Breaking one is a bug even if
the feature works.

1. **Zero runtime dependencies.** Node 18+ built-ins only (`node:http`,
   `node:fs`, `node:path`, `node:url`, `node:child_process`, `node:events`).
   There is no `npm install`, no lockfile, no build step, and no bundler. The
   browser code is plain ES in three files served as-is. Do not add a package,
   a framework, a CSS preprocessor, or a transpile step — propose it and let
   the user decide instead.
2. **Loopback only.** The server binds `127.0.0.1`. Never bind `0.0.0.0`, and
   never add a route that would be useful to a remote caller.
3. **Every non-GET request passes the write gate.** See
   [The write gate](#the-write-gate).
4. **`data/` is never committed.** It holds headlines, descriptions, working
   directories and "where it left off" text for every session in every project
   — very likely client-confidential. It is gitignored; keep it that way, and
   never paste its contents into a commit message, an issue, or a README
   example.
5. **Claude never marks a card Done.** The `done` column is the user's alone.
   The CLI has no `done` subcommand and must not grow one.

---

## Layout

```
server.js            HTTP server: REST API + static UI + SSE. ~510 lines.
lib/config.js        port/paths resolution (PORT env, data/server.port)
lib/store.js         the whole data model: in-memory board, debounced atomic
                     save, column logic, project roll-ups. The big one.
lib/transcript.js    extractors over Claude Code transcripts (.jsonl):
                     last assistant message, model, ai-title, slug, git branch
lib/usage.js         usage-limits fetch + tolerant normalizer (undocumented API)
lib/settings.js      server-side settings (data/settings.json)
lib/skip-prompts.js  the skip list — commands that don't earn a card
lib/origin.js        the Origin + Host gate on every write
bin/status.js        the one CLI: hook subcommands, Claude subcommands,
                     ensure-server, session resolution
public/index.html    markup for all three views (board/projects/archive)
public/app.js        the entire front end, ~1950 lines, no framework
public/styles.css    all styling, hand-written custom properties
test/                node:test suites (no runner dependency)
examples/            hook JSON, CLAUDE.md snippet, /post-status — setup copy
data/                runtime state. gitignored. see constraint 4.
```

### Data flow, end to end

```
Claude Code hook ──► bin/status.js <subcmd> ──► HTTP POST ──► server.js
                                                                 │
                                              lib/store.js ◄─────┘
                                                   │
                              debounced atomic write to data/board.json
                                                   │
                                          store.emit('change')
                                                   │
                                    SSE /api/events ──► public/app.js
```

`bin/status.js` calls `ensureServer()` before most requests, which
health-checks `/api/health` and spawns `server.js` detached if it is down. The
one deliberate exception is the skip-listed branch of `hook-user-prompt`: a
session that only ever runs `/git-commit-message` must not start the dashboard
at all, so that path does its skip-list check against a local file *before* any
network or spawn.

---

## Running and testing

```sh
node server.js                     # foreground; usually already running
node bin/status.js ensure-server   # start only if down
node bin/status.js url             # print the dashboard URL
npm test                           # node --test over test/
```

- **Front-end changes** (`public/*`) need only a browser reload. Everything is
  served with `Cache-Control: no-store`, so there is no cache to bust.
- **Server changes** (`server.js`, `lib/*`) need a restart, and a restart is a
  visible event for the user — see below.
- **Tests** are `node:test` with `node:assert`. `test/store-projects.test.js`
  is the pattern to copy: construct a real `Store`, stub `_scheduleSave`, and
  replace `store.board` with a fixture. The constructor only *reads*
  `data/board.json`, so tests never touch the user's real board — preserve that
  property in any new suite.
- `lib/origin.js` is a pure function of two headers precisely so the gate can
  be tested without binding a port. Keep new security decisions equally
  testable.

### Working on a live system

- **Restarting the server is user-visible.** Every other open session's card
  lives in this process. `flushSync()` on `SIGINT`/`SIGTERM` protects the data,
  but the user's dashboards will blink and reconnect. Say so before you do it,
  and prefer doing it once at the end over a restart per iteration.
- **A second instance is harmless but useless.** `EADDRINUSE` makes the new
  process exit quietly, leaving the original owner of `data/board.json` in
  place. If a change seems not to have taken effect, check whether the old
  process is still the one on the port (`node bin/status.js ensure-server`
  reports health, not identity — check `data/server.pid`).
- **Never hand-edit `data/board.json` while the server is up.** The in-memory
  board is authoritative and the next debounced save overwrites the file.
- **Verifying in a browser touches real data.** The board shows real project
  names and session text. Screenshots of it must not be committed —
  `.gitignore` blocks stray `*.png`/`*.jpg` for this reason, with only curated
  `docs/` images allowed through.

---

## Architecture notes worth having before you edit

### `lib/store.js` — the data model

- The board is one in-memory object; writes mutate it and call
  `_scheduleSave()`, which debounces 120 ms and then does an **atomic write**
  (temp file + rename), falling back to an in-place write on Windows `EPERM`.
  One `'change'` event fires per debounced save, so an SSE burst is coalesced.
- **Paths are compared through `normalizePath()`** (separators folded to `\`,
  lowercased). Every place that groups by project — `listCards()`,
  `projects()`, `projectSummary()`, `resolveByProject()` — must go through it,
  or the same folder recorded with a different drive-letter case splits into
  two projects. This is Windows-shaped and knowingly so; see the README's
  platform section.
- A **corrupt JSON file is backed up, not lost** (`readJsonSafe` writes a
  `.bak-preupgrade` sibling and falls back). Keep that behaviour in any new
  file reader.
- Columns: `DEFAULT_COLUMNS` are reconciled into an existing board on every
  boot, so label/colour changes propagate — but the user's custom columns and
  their chosen order are left alone. `done` stays pinned last.

### `public/app.js` — the front end

One file, no framework, no build. Conventions in force:

- **`el(tag, attrs, children)`** is the only DOM constructor. It handles
  `class`, `text`, `html`, `style`, `on*` handlers and plain attributes. Use it
  rather than template strings — the one place strings are used
  (`renderProjectFilter`, `renderCommandFilter`) escapes through
  `escapeHtml()` and exists only because `<option>` lists are replaced
  wholesale.
- **`setOptions(sel, html)`** replaces a `<select>`'s options only when the
  markup actually changed. `render()` runs on every refresh, and rewriting
  `innerHTML` under an open or focused dropdown closes it and loses the
  keyboard position. Any new `<select>` that re-renders must use it.
- **State lives in the `state` object at the top**, preferences persist through
  `loadPrefs()`/`savePrefs()` into one `localStorage` key. **Every persisted
  value is validated on read** against a known set, because a stale or
  hand-edited pref must never leave the user looking at an empty board, or a
  hidden panel, with no visible way back. Follow that pattern for anything new.
- **Client-side filters call `render()`, not `refresh()`.** `refresh()` is a
  round trip and is only needed when the server's answer changes (the project
  filter, which is a query parameter).
- **SSE uses a leader election.** Browsers cap concurrent HTTP/1.1 connections
  per origin at 6, and an `EventSource` holds one open indefinitely — a stream
  per tab meant six open dashboards starved every subsequent `fetch`. One tab
  holds a Web Lock, owns the only stream, and fans events out over
  `BroadcastChannel`. Do not open an `EventSource` anywhere else.
- **Accessibility is a maintained property here, not an afterthought.** The
  view switcher is a real `role="tablist"` with roving `tabindex` and
  activation-follows-focus; the filter note is a `role="status"` live region
  because the board is rebuilt wholesale and would otherwise change in silence;
  the scrollable table is focusable; the usage meters redraw under forced
  colours. New UI is expected to hold the same line. `wordpress-accessibility-patterns`
  is not the right reference here (this is not WordPress) — WCAG 2.2 AA and the
  ARIA APG patterns are.

### The write gate

`lib/origin.js` decides it, `server.js` applies it **once** at the top of
`handleApi()`. Reads are open; every other method needs a trusted `Origin`
(exact match against this server's own two origins, or absent — which is how
the non-browser CLI gets through) *and* a loopback `Host` (which is what
defeats DNS rebinding).

The single check point is the design: it started life guarding only
`open-folder`, and `DELETE /api/cards/:id` sat unprotected because a
cross-origin form POST with `Content-Type: text/plain` still parses as JSON on
the way in. **Do not reintroduce per-route gating** — a new write endpoint must
be covered the day it is added.

`open-folder` keeps an extra restriction on top: the path comes only from a
stored card record, never from the request body.

### Hooks and the skip list

Card creation is on `UserPromptSubmit`, not `SessionStart`, because opening a
chat you never use should not mint a ticket. Every *other* hook path — the Stop
backstop, model recording, external-edit tracking, session-end — **no-ops when
the card is absent** rather than creating one. That is what makes suppressing
creation at one point sufficient; preserve it.

`lib/skip-prompts.js` matching is deliberately strict: the prompt must be the
invocation and nothing else. Anything unrecognized falls through to "real
work", which is the safe direction to fail. A malformed or empty override file
restores the defaults rather than turning skipping off.

---

## Code conventions

- **`'use strict';` at the top of every file.** CommonJS throughout
  (`"type": "commonjs"`); no ESM, no `import`.
- **Comments explain *why*, at length.** This codebase's comments are unusually
  narrative on purpose: they record the reasoning and, often, the bug that
  produced the current shape ("this used to guard only open-folder, and…").
  That is the house style — match it. A comment that restates the code is
  noise; a comment that says which failure the line prevents is the point.
  When you change a behaviour, **update the comment that justified the old
  one** rather than leaving it to contradict the code.
- Two-space indent, semicolons, single quotes, trailing commas in multi-line
  literals.
- Errors degrade, they do not crash. `try/catch` with a `/* ignore */` or a
  best-effort fallback is idiomatic here — a hook must never take a session
  down, and a failed usage fetch must never blank the board.
- Front-end and back-end share no module system; small pieces of logic are
  deliberately mirrored (`skipCommandNames` exists in both `lib/store.js` and
  `public/app.js`). When you touch one, check the other — the mirroring is
  noted in comments at both sites.

### Documentation register

Per the user's global instructions: **README.md is written in Simplified
Technical English** for a human reader — short sentences, active voice, no
marketing language, every claim verified against the code. Use the
`readme-auditor` skill when revising it. **This file, and code comments, are
the verbose technical register** — say the *why* at whatever length it needs.

Keep the README honest. It documents behaviour in fine detail (thresholds,
counts, exactly which filter tracks which toggle), so a behaviour change that
lands without a README edit leaves a false statement in the manual.

### Version numbers

`package.json` is the only place the version is written. Per the user's global
rule: **bump the patch position only.** Minor and major are the user's call.

---

## Git

The user manages their own git workflow. **Do not commit, push, create PRs, or
comment on GitHub unless explicitly asked** — this is enforced by deny rules as
well as by instruction. `/git-review` is the user's pre-commit gate; running it
is their move, not yours.

Note the irony worth remembering: `/git-review` and `/git-commit-message` are
on this project's own skip list, so a session that only runs them leaves no
card behind.

---

## Keeping your own card current

This project defines the dashboard the user watches. Its own status conventions
apply here as everywhere else:

```sh
node bin/status.js set --headline "…" --body "…"     # at the start of real work
node bin/status.js note --bullet "…"                 # as a task sprawls
node bin/status.js needs-input --body "…"            # blocked on the user
node bin/status.js done-for-review                   # you think it is ready
```

The session id resolves automatically from `CLAUDE_CODE_SESSION_ID`, so
`--session` is rarely needed. Never mark a card done.
