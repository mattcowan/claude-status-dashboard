# Integration Brief — Fold the devnotes review dashboard NATIVELY into claude-status-dashboard

**Audience:** a future Claude Code session implementing this.
**Written:** 2026-07-18 (rev 2). **Status:** design brief, nothing implemented yet.
**Goal (user's words):** "I want this to replace the existing devnotes dashboard… we're more
folding this into the claude status dashboard than linking to it. I will be making larger
changes to the devnotes dashboard [going forward]."

> **Decision (rev 2):** Do a **native re-implementation in Node** — the status dashboard
> *becomes* the devnotes review UI, as a new tab, in the same process and the same zero-dep
> vanilla-JS SPA. The standalone Python `review_server.py`/`review_server_git.py` UIs are
> **retired**. This supersedes the rev-1 iframe recommendation (iframe was about *linking*
> two apps; the user wants *one* app). iframe/proxy notes are kept only as a fallback in §9.

---

## 0. The two load-bearing scoping decisions (settle these first)

Native port of the **UI + JSON endpoints + state writes** is decided. Two sub-decisions
shape the rest; the brief assumes the **recommended** answer to each and flags where it
matters:

1. **`publish.py` (markdown→Gutenberg conversion + WordPress REST + reident-PASS gate):**
   - ✅ **Recommended: keep it as a Python subprocess push-engine.** Node shells out
     `python publish.py <draft.md> [--publish]` for the actual push and for preview HTML.
     Rationale: `md_to_blocks` must stay **byte-identical to what is pushed** (the current UI
     guarantees preview == push), and this converter + the WP auth + the reident gate are the
     riskiest, least-UI parts to re-port. Keep them in the one tested place.
   - Alternative: full JS re-port of the four functions (§6). Only do this if you want to
     delete Python entirely. If so, the reident gate and byte-fidelity are the acceptance bar.

2. **Data source:**
   - ✅ **Recommended: the dashboard reads/writes the existing `~/dev-notes/` flat files**
     (drafts, `review-state*.json`, `mining-report*.json`, `mining-summaries*.json`,
     `inbox.md`). The devnotes **skill** and its **miners** (`mine_history/git/project.py`)
     and `publish.py` all still use `~/dev-notes`; keeping the same files means they keep
     working and the dashboard is just a better UI over them. Preserve the schemas in §7 exactly.
   - Alternative: migrate devnotes data into the dashboard's `data/` store. Breaks skill/miner
     interop unless you also rewrite those. Not recommended.

Everything below assumes: **native UI+API+state in Node, `~/dev-notes` as the shared data
dir, `publish.py` as a subprocess.**

---

## 1. What "retiring the Python UI" concretely means

Replace (port to Node): `review_server.py` and `review_server_git.py` — the HTTP serving, the
inline HTML/JS pages, the ~17 JSON endpoints, and the state read/writes they do.

Keep (unchanged, external to the dashboard):
- `publish.py` — invoked as a subprocess (recommended) — WP push + markdown→Gutenberg + gate.
- `mine_history.py`, `mine_git.py`, `mine_project.py` — the miners that generate
  `mining-report*.json`; run from the skill/CLI, write `~/dev-notes`.
- The **devnotes skill** itself (drafting, anonymization, adversarial pass) — writes drafts +
  `review-state*.json` in `~/dev-notes`.
- All `~/dev-notes/*` data files (the contract between all of the above and the new UI).

So the boundary is clean: **the dashboard owns the *review UI and its state mutations*; the
skill/miners/publish own *generation and publishing*; `~/dev-notes` is the shared bus.**

---

## 2. Target app shape (where things go)

`claude-status-dashboard` — Node, CommonJS, **zero external deps**, raw `node:http`, static
vanilla-JS SPA (`public/`), flat-JSON data layer (`lib/store.js`), SSE for live updates. Keep
all of that — the devnotes port must stay dependency-free and match the existing patterns.

- **New nav tab** in the SPA, using the existing board↔archive view-toggle precedent
  (`public/index.html:27` button, `:36-43` sections; toggle at `public/app.js:820-826`,
  state flag at `:7`, wiring at `:806-841`). Add `state.devnotesOpen` and a `#devnotesSection`.
- **New client module** for the devnotes view. The existing `app.js` is 875 lines of one-file
  vanilla JS; either extend it or add `public/devnotes.js` loaded from `index.html` (no build
  step, so just another `<script>`). Reuse the `api(method,path,body)` helper
  (`public/app.js:188-197`) and the SSE client (`:848-874`).
- **New backend module** `lib/devnotes.js` for the `~/dev-notes` read/writes and subprocess
  push, mirroring how `lib/store.js`/`lib/usage.js` are structured. Wire its routes into the
  dispatcher in `server.js` (`handleApi` at `:86-261`, or a `/api/devnotes/*` branch added
  before the `/api/` catch-all at `:331`).
- **Data reads/writes** go to `~/dev-notes` (via a `lib/devnotes.js` path config), NOT the
  dashboard's `data/` dir. Reuse the atomic-write discipline from `lib/store.js:91-106`.

---

## 3. Endpoints to port (Python → Node `/api/devnotes/*`)

Map the current Python routes onto native Node handlers. Suggested namespacing under
`/api/devnotes/` to avoid colliding with existing routes.

From `review_server.py` (port 8765):
| Python route | New Node route | Behavior to reproduce |
|---|---|---|
| `GET /api/state` | `GET /api/devnotes/state` | Build the whole page model: `{candidates, project_candidates, git_candidates, inbox, drafts, wp_configured, wp_missing, wp_url, push_progress}`. (Fold the git lane in here rather than a 2nd server.) |
| `GET /api/draft?name=` | `GET /api/devnotes/draft?name=` | Return raw draft file text. **Keep the filename-safety check** (basename-only, `.md`, no traversal). |
| `POST /api/draft {name,content}` | `POST /api/devnotes/draft` | Save draft (LF newlines), atomic. |
| `POST /api/preview {markdown}` | `POST /api/devnotes/preview` | Return Gutenberg HTML. Subprocess: pipe markdown through publish's converter (see §6), or JS port. |
| `POST /api/push {name}` | `POST /api/devnotes/push` | Subprocess `python publish.py <draft>`; on success record `draft::<name>` state. |
| `POST /api/push-all {names?}` | `POST /api/devnotes/push-all` | Batch push; stream progress over the existing SSE (`/api/events`) instead of the Python in-memory dict. |
| `POST /api/request {transcript}` | `POST /api/devnotes/request` | Toggle requested/unrequested in `review-state.json`. |
| `POST /api/skip {transcript}` | `POST /api/devnotes/skip` | Set status `skipped`. |
| `POST /api/dismiss-pushed` | `POST /api/devnotes/dismiss-pushed` | Set `dismissed:true` on all `draft::` records. |
| `POST /api/dismiss-cleared` | `POST /api/devnotes/dismiss-cleared` | Mark skipped transcript candidates `dismissed`. |
| `POST /api/project/{request,skip,dismiss-cleared}` | `…/api/devnotes/project/*` | Same, against `review-state-project.json`. |
| `POST /api/inbox/check {session_id}` | `POST /api/devnotes/inbox/check` | Flip `- [ ]`→`- [x]` in `inbox.md`. |

From `review_server_git.py` (port 8766) — **fold in, don't run a 2nd server**:
| `GET /api/state → {candidates}` | included in `/api/devnotes/state` as `git_candidates` |
| `POST /api/request {transcript}` | `POST /api/devnotes/git/request` (note: git's toggle **preserves a `draft` pointer** on unrequest — replicate that nuance) |
| `POST /api/skip {transcript}` | `POST /api/devnotes/git/skip` |

Simplifications you GET for free going native/same-origin:
- **Drop the `X-Devnotes: 1` header / CSRF shim** — same-origin + loopback is enough (the
  dashboard's own API has no such header today).
- **Batch-push progress → SSE.** The dashboard already streams `/api/events`
  (`server.js:305-314`); push progress rides that instead of a polled in-memory dict, so no
  process-local progress state to worry about.
- **One process, one lock.** Node's event loop serializes handlers; keep an async mutex/queue
  for `review-state*.json` read-modify-write to preserve atomicity (Python used a threading
  lock; in Node, serialize the write section).

---

## 4. The three lanes + inbox + drafts (data assembly to reproduce)

`GET /api/devnotes/state` must reproduce the Python assembly (all from `~/dev-notes`):
- **Transcript lane:** `mining-report.json` (`candidates[]`) — or parse `mining-report.md`
  as fallback — merged with `mining-summaries.json` (by transcript path: adds
  `headline/summary/postable`), annotated with `status` from `review-state.json`. Hide
  `dismissed`/`drafted`; split requested vs skipped.
- **Project lane:** `mining-report-project.json` + `mining-summaries-project.json` +
  `review-state-project.json`. Extra fields `evidence/kind_detail/why/title` render specially.
- **Git lane:** `mining-report-git.json` + `mining-summaries-git.json` +
  `review-state-git.json`. Fields `commits[]/commit/repo/linked_transcript/case_study/
  files[]/body_excerpt/detector`.
- **Inbox:** parse `inbox.md` lines `- [ ] <date time> -- session <sid> in <cwd>`; resolve
  `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` and report existence. (Encoding: drive-letter
  lowercased, `:`,`\`,`/` → `-`.)
- **Drafts:** glob `~/dev-notes/drafts/*.md`; read frontmatter (`title, reident_verdict,
  status, mined_from`); overlay push info from `draft::<name>` records. Segment into unpushed
  main / unpushed project / pushed.

Join keys (unchanged): transcript `.jsonl` path (report↔summaries↔state); draft basename
(state `.draft` ↔ `draft::` key ↔ file).

---

## 5. UI to port

Both Python pages are a single inline HTML string with inline CSS/JS, vanilla, no framework —
which maps cleanly onto this dashboard's SPA style. Port, don't transplant:
- Rebuild the **candidate cards, drafts list, and the markdown editor + live preview pane** as
  dashboard-native markup/CSS (match `styles.css`, don't paste the Python CSS).
- The editor: textarea + debounced `POST /api/devnotes/preview` (400 ms) → render returned
  Gutenberg HTML in a preview pane (current behavior). Save button → `POST /api/devnotes/draft`.
- Per-draft **Push** and **Push all PASS / Push checked** buttons → the push endpoints; reflect
  progress from SSE.
- The "Copy Claude prompt" buttons are **client-side only** (build a string, `navigator.
  clipboard`) — port as-is, no endpoint.
- Since you're making larger changes anyway, this is the moment to restructure the UI rather
  than mirror the Python layout 1:1.

---

## 6. `publish.py` — the four functions (subprocess contract, or JS-port spec)

`review_server.py` used four names from `publish.py`. In the recommended subprocess approach you
mostly shell out; this is the spec either way:
- `parse_frontmatter(text) -> (meta:dict, body:str)` — YAML-ish; inline `[a,b]` lists, dash
  lists under an empty key, quote-stripped scalars. (Cheap to JS-port; you'll likely want a JS
  version just to *read* frontmatter for the drafts list without spawning Python.)
- `md_to_blocks(md) -> str` — markdown → Gutenberg block-comment HTML (paragraphs, ATX
  headings, `-`/`*` lists, blockquotes, fenced code; inline code/strong/em/links with URL
  scheme-sanitizing). **Byte-fidelity matters** (preview == push). Prefer subprocess unless you
  accept re-verifying fidelity.
- `api(base,user,app_pw,method,route,payload,query) -> dict` — WP REST, HTTP Basic with an
  **App Password**, 30s timeout. **Calls `sys.exit` on HTTP error** — so if you ever import it
  in-process you must guard; via subprocess you just read the exit code + stderr.
- `resolve_terms(...) -> [int]` — category/tag name→ID, may create terms.

**The reident gate (must be preserved):** publish refuses unless frontmatter
`reident_verdict` upper-cases to exactly `PASS` (`publish.py:197-200`). Subprocess keeps this
for free. A JS port MUST re-implement it — never let the UI push a non-PASS draft.

**WP creds:** `DEVNOTES_WP_URL`, `DEVNOTES_WP_USER`, `DEVNOTES_WP_APP_PASSWORD` (also read from
Windows registry `HKCU\Environment` by the Python side). The Node process must pass these
through to the `publish.py` subprocess env (it inherits by default). Push defaults to WP
**draft**; category defaults to "Development Notes". **Never** hardcode/log the app password;
it stays an env var. Editing/saving works without creds; only push needs them. Surface
`wp_configured`/`wp_missing` in state so the UI can disable Push when unset (current behavior).

If full JS port instead of subprocess: WP call = built-in `https.request` +
`Authorization: Basic ${Buffer.from(user+':'+pw).toString('base64')}` (stays zero-dep).

---

## 7. Data contracts to preserve exactly (`~/dev-notes`)

Keep these byte-compatible so the skill, miners, `publish.py`, and prior reconciliation keep working:
- `drafts/*.md` frontmatter: `title, date, lane, tags[], status, client, redactions[],
  reident_verdict, reident_notes, mined_from`; body markdown (leading H1 repeating title is
  stripped at push time by publish).
- `review-state.json`: transcript-path key → `{status: drafted|dismissed|skipped, ts, draft?,
  reason?, mined_from?}`; `draft::<basename>` key → `{status: pushed, post_id, edit_url, ts,
  dismissed?}`. Writes MUST be atomic (temp+rename) and serialized.
- `review-state-project.json`, `review-state-git.json`: same idea, independent files.
- `mining-report.json`: `{generated, candidates:[{date,project,opened_with,errors[],
  transcript,score,resolved}]}` (+ `.md` fallback). `-git`/`-project` variants add the
  lane-specific fields listed in §4.
- `mining-summaries*.json`: keyed by transcript path → `{headline,summary,postable}`.
- `inbox.md`: `- [ ] <date time> -- session <sid> in <cwd>` (checkbox → `[x]`).

---

## 8. Gotchas specific to the native fold-in

1. **Preserve `~/dev-notes` schemas or you break the skill.** The miners write reports, the
   skill writes drafts + state, `publish.py` reads drafts + writes push state. The dashboard
   is now a co-writer of `review-state*.json`/`inbox.md`/`drafts` — match formats in §7 and
   keep writes atomic + serialized (Node: an async write-queue per file).
2. **Byte-fidelity of preview==push.** Subprocess to `publish.py` guarantees it; a JS
   `md_to_blocks` must be diffed against the Python output before trusting Push.
3. **The reident PASS gate is a safety feature, not a formality.** It's the last stop before a
   client-identifying draft could go live. Keep it enforced server-side, not just in the UI.
4. **Two lanes were a second server; now they're views.** Fold git-lane data into
   `/api/devnotes/state` and add git request/skip endpoints; replicate git's
   drafted-pointer-preserving toggle nuance.
5. **Drop the Python-era CSRF header**, but keep everything **loopback-only**. Don't bind to
   `0.0.0.0`.
6. **Edit the Dropbox-synced skill source** (`C:\Users\matth\Dropbox\claude-config\skills\
   devnotes`) if you touch any Python — `~/.claude/skills` is the synced live copy. But note:
   once the UI is native, you should **stop launching the Python review servers** (the skill
   docs currently tell users to run `review_server.py` on 8765 / `review_server_git.py` on
   8766 — update the SKILL.md to point at the dashboard tab instead).
7. **WP creds pass-through** to the subprocess; surface configured/missing state to disable Push.
8. **Retire the old servers cleanly:** once ported, remove/deprecate `review_server.py` +
   `review_server_git.py` (or leave them as thin "use the dashboard" stubs) and update the
   skill's SKILL.md §"review UI" + INSTALL docs.

---

## 9. Fallback only (NOT the plan): iframe / reverse-proxy
If the native port is ever deferred, the interim was: iframe a supervised `review_server.py`
(port 8765) in a tab, or reverse-proxy `/devnotes/*`→8765 (forwarding `X-Devnotes:1`). Both
keep Python as the UI and are explicitly *not* what the user wants long-term. Details omitted;
see git history rev 1 if needed.

---

## 10. Suggested build order (native)
1. `lib/devnotes.js`: `~/dev-notes` path config + readers for all lanes/inbox/drafts; a
   JS `parse_frontmatter` (read-only) so the drafts list needs no Python.
2. `GET /api/devnotes/state` + the read-only tab UI (candidates/inbox/drafts, no editing yet).
   Verify it renders the same data the Python UI showed.
3. Draft editor: `GET/POST /api/devnotes/draft` + `POST /api/devnotes/preview` (subprocess to
   publish's converter). Confirm preview matches the Python preview byte-for-byte.
4. State mutations: request/skip/dismiss (transcript, project, git) with atomic serialized
   writes; `inbox/check`. Diff resulting `review-state*.json` against the Python server's output.
5. Push: `POST /api/devnotes/push` (subprocess `publish.py`), then `push-all` streaming over
   SSE. Test with WP creds exported; confirm `draft::` records + the reident gate behavior.
6. Retire Python UIs; update SKILL.md/INSTALL to point at the dashboard tab.
7. (Optional, later) JS-port `publish.py` to drop Python entirely — only if desired.

---

## 11. File reference index
**Target (this repo):** `server.js` (router `:325-338`, `handleApi` `:86-261`, static `:64-84`,
startup `:355-364`, SSE `:305-314`, shutdown `:388-393`); `lib/config.js` (host/port `:10-24`);
`lib/store.js` (data layer + atomic write `:91-106`); `lib/usage.js` (module pattern to mirror);
`public/index.html` (topbar `:27`, sections `:36-43`); `public/app.js` (state `:7`, toggle
`:820-826`, wiring `:806-841`, `api()` `:188-197`, SSE `:848-874`); `bin/status.js` (subprocess
spawn pattern `:67-89`).
**Source to port/retire (devnotes):** `~/.claude/skills/devnotes/scripts/review_server.py`
(8765, full UI/API); `…/review_server_git.py` (8766, git triage); `…/publish.py` (keep as
subprocess). Editable mirror: `C:\Users\matth\Dropbox\claude-config\skills\devnotes\`.
**Shared data bus:** `~/dev-notes/` (drafts, `review-state*.json`, `mining-report*.json`,
`mining-summaries*.json`, `inbox.md`) — schemas in §7.
**Still-Python, keep:** `mine_history.py`, `mine_git.py`, `mine_project.py`, `publish.py`, the
devnotes skill.

---

## 12. Open decisions for the user
1. `publish.py` as subprocess (recommended) vs full JS re-port now?
2. Confirm `~/dev-notes` stays the data source (recommended) vs migrating into dashboard `data/`.
3. Fold the git lane into the one tab (recommended) — one tab with sub-sections, or separate tabs
   per lane?
4. On retirement, leave `review_server*.py` as "use the dashboard" stubs, or delete outright?
5. Is dropping Python entirely (JS-port publish + miners) an eventual goal, or is "one UI app"
   the end state?
