# Claude Session Status Dashboard

A local Kanban board that tracks the status of **every Claude Code session** across
all your projects — so when you have several sessions running at once you can see
at a glance which are working, which need you, and which are ready for review.

Open it at **http://127.0.0.1:4787**.

```
┌── Working ──────┐  ┌── Needs Input ──┐  ┌ Ready for Review ┐   (Done: hidden,
│  live sessions  │  │  waiting on you │  │  ready to review │    toggle to show)
└─────────────────┘  └─────────────────┘  └──────────────────┘
```

One **card per Claude session**, keyed by its session id and tagged with the
project folder it ran in. Cards move through columns automatically as sessions
work and stop; **you** decide when something is truly *Done*.

---

## How it works

- **Zero dependencies.** Pure Node (v18+); nothing to `npm install`. A single
  long-lived server process owns `data/board.json`, so many sessions writing at
  once never race.
- **Auto-starts itself.** The first-prompt hook health-checks the server and
  launches it (detached) if it's down — you never have to remember to start it.
- **Cards are created and moved by hooks + a tiny CLI:**

| Trigger | What happens |
|---|---|
| **First prompt** (UserPromptSubmit hook) | Creates this session's card in **Working**, tagged with the folder. Only fires once you actually send a message, so opening an empty chat never makes a ticket. |
| **Every prompt / Stop** | Refreshes the card's session metadata from the transcript: the **auto-generated session title** (same as the VS Code tab title — shown italic as the headline until Claude sets one), the plan **slug**, the **git branch** (⎇ badge, linked on GitHub repos), and the transcript path. |
| Claude runs `status.js set` | Sets the headline + description (stays **Working**). |
| Claude runs `status.js note` | Appends a bullet as the task sprawls. |
| Claude runs `status.js needs-input` | Deliberate hand-off → **Needs Input**. |
| Claude runs `status.js done-for-review` | Claude thinks it's ready → **Ready for Review**. |
| **Stop** hook (backstop) | If Claude left the card in *Working*, captures "where it left off" from the transcript, moves it to **Needs Input**, and flags it **⚙ auto-captured**. |
| **PostToolUse(Edit\|Write)** hook | Any file edited *outside* the project folder is listed on the card (⚠ external edits). |
| **SessionEnd** hook | Marks the session **ended** (live-dot turns grey). |
| You, in the UI | **Mark done**, **Archive**, **Restore**, or **Delete**. |

The **⚙ auto-captured** badge is the tell: it means the Stop backstop moved the
card because Claude didn't declare an outcome — as opposed to a deliberate
*Ready for Review*.

---

## Running it manually

```sh
node server.js            # start the server (usually unnecessary — hooks do it)
node bin/status.js ensure-server   # start it only if not already running
node bin/status.js url    # print the dashboard URL
```

Port is `4787` by default; override with the `PORT` env var or by writing a
number into `data/server.port`.

## The CLI (what Claude calls)

```sh
node bin/status.js set --headline "Fix checkout tax rounding" --body "…"
node bin/status.js note --bullet "Reproduced with a 3-item cart"
node bin/status.js needs-input --body "Confirm whether the AJAX handler is public"
node bin/status.js done-for-review
```

**Session resolution** (so Claude rarely needs to know its id): `--session <id>`
→ the `CLAUDE_CODE_SESSION_ID` env var Claude Code exposes to Bash → the
most-recently-active non-done card whose project equals the current working
directory. If no card exists yet (e.g. a `/post-status` in a session that
predates the hooks), the CLI creates one.

## Hooks (installed in `~/.claude/settings.json`)

All four call this one script in **exec form** (the hook JSON arrives on stdin):

```jsonc
{ "type": "command", "command": "node",
  "args": ["C:\\wamp64\\www\\claude-status-dashboard\\bin\\status.js", "<subcmd>"] }
```

| Event | Subcommand |
|---|---|
| `UserPromptSubmit` (appended after the existing hooks) | `hook-user-prompt` — creates the card on the first prompt |
| `Stop` (appended after the existing hook) | `hook-stop` |
| `PostToolUse` matcher `Edit\|Write` | `hook-post-edit` |
| `SessionEnd` (appended after the existing hook) | `hook-session-end` |

(Card creation is on `UserPromptSubmit` rather than `SessionStart` on purpose:
`SessionStart` fires when a chat *opens*, which produced empty tickets for
sessions you never used.)

## The `/post-status` command

Run **`/post-status`** inside any Claude session to make it post its current
status to the board on demand (handy for sessions that were already running
before the hooks existed, or any time you want an up-to-the-moment snapshot).
It's a custom slash command at `~/.claude/commands/post-status.md`; the session
summarizes its work, picks Working / Needs Input / Ready for Review, and posts via
the CLI. Add a note inline, e.g. `/post-status blocked on the staging DB creds`.

(Named `post-status` rather than `status` deliberately — Claude Code has a
built-in `/status`, so a custom `status` command would collide with it.)

## Usage limits strip

The bar under the header shows your Claude subscription usage — the 5-hour
session window, the weekly all-models window, and any per-model weekly windows.
Buckets are **discovered dynamically** from the response, so when Anthropic
changes the definitions (Opus-only week, Sonnet-only week, …) the strip follows
without code changes.

Each meter carries a small **pace marker** — a tick showing where usage *would*
be if it were spread evenly across the window (`elapsed / window length`). If the
fill sits left of the tick you're **under pace**; right of it (tick turns red)
you're **on track to exceed** before the reset. Hover any meter for the exact
numbers ("Even pace ≈ 54% by now · you're at 52% (on pace)"). The window length
is inferred from the bucket kind (5 hours for the session, 7 days for weekly);
an unrecognized bucket simply shows no marker.

**Color follows pace, not the raw percentage** — a number on its own says little,
since 70% used is fine 80% into the window and alarming 20% in. Meters stay green
while at or under pace, turn amber once usage runs more than 2 points ahead of
pace (a small deadband, so a meter sitting right on the tick doesn't flicker),
and go red only when ahead of pace *and* at 90% or more — within 10 points of the
cap. So a high-but-on-track meter
stays green, while a session that burns 30% in its first 15 minutes goes amber
immediately. (A bucket with no known window length has no pace to compare against
and falls back to fixed 60% / 85% thresholds.)

Under **Windows Forced Colors / high-contrast**, the meters redraw with system
colors (track outline + marker in `CanvasText`, fill in `Highlight`) so the bar
and pace tick stay visible — the color coding is replaced by the tick position
and the % text, which carry the same meaning without relying on hue.

- **Where it comes from:** Anthropic's **undocumented** OAuth usage endpoint,
  authenticated with the same token Claude Code already stores in
  `~/.claude/.credentials.json`. It may change or break without notice (the ⓘ
  in the strip says the same); failures degrade to a stale/error note, never a
  crash. A response the normalizer doesn't recognize is dumped to
  `data/usage-last-raw.json` so `lib/usage.js` can be recalibrated against it.
- **When it refreshes:** whenever a session pings the dashboard (throttled to
  once per 5 min), or via the strip's **↻** button (30s floor). Background
  polling on a timer exists but is **off by default** — enable it in the strip's
  **⚙** settings (persisted server-side in `data/settings.json`).
- If the token has expired, the strip says so; opening any Claude Code session
  refreshes it.

## Live updates & notifications

- The board listens on **SSE** (`/api/events`) and re-renders the moment a hook
  fires; polling (3s) remains as a fallback and slows to a 15s heartbeat while
  SSE is healthy.
- **🔔 Notify** (topbar) sends a desktop notification when a card *enters*
  **Needs Input** or **Ready for Review** — only for changes that happen while
  the tab is unfocused, and only after you opt in (permission is requested from
  the toggle, never on load).
- Cards idle for 10+ minutes (and not ended) get a **💤** badge with the
  relative time — an at-a-glance "this one's waiting on someone."

## Plan & transcript on the card

Expanded cards link to the artifacts behind the session: **📄 Plan** opens the
plan file Claude Code wrote for that session (`~/.claude/plans/<slug>*.md`) in a
modal, and the transcript path is shown with a **📋** copy button.

## Data & files

```
server.js            HTTP server (REST API + static UI + SSE)
lib/config.js        port / paths
lib/store.js         in-memory board + atomic debounced save + label logic
lib/transcript.js    transcript extractors (last message, model, title/slug/branch)
lib/usage.js         usage-limits fetcher + tolerant normalizer (undocumented API)
lib/settings.js      server-side settings (data/settings.json)
bin/status.js        the one CLI (hooks + Claude subcommands + ensure-server)
public/              index.html, app.js, styles.css  (self-contained UI)
data/                board.json, archive.json, settings.json, usage.json,
                     server.port/pid/log  (runtime)
```

- **Active** cards live in `data/board.json`; **archived** (dumped) cards move to
  `data/archive.json`. Both are plain JSON you can inspect or back up.
- Writes are atomic (temp file + rename) and debounced, and a corrupt file is
  backed up rather than lost.

## Notes

- Loopback only (`127.0.0.1`) — not exposed to your network.
- The board updates live via SSE (with polling as fallback); drag cards between
  columns or use the buttons.
- "Done" is hidden by default (toggle **Show done**); **Dump done → archive**
  moves all done cards into the Archive view for long-term keeping.

### Custom columns

**Working / Needs Input / Ready for Review** are the three fixed "root" columns
Claude uses; **Done** is always pinned last (hidden by default). You can add your
own columns in between — e.g. a **Merging** column you manage by hand:

- **＋ Column** in the header adds one (auto-assigned a color). Hover a column
  header for its controls: **‹ ›** reorder, **✎** rename, **×** delete.
- Custom columns are **yours only** — Claude never moves cards into them, and the
  Stop backstop won't touch a card you've dragged into one. Reorder any column
  freely (Done stays last).
- **Deleting a custom column that still holds cards** asks what to do with them:
  move them to another column, or archive them all.
