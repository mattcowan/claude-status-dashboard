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

## Data & files

```
server.js            HTTP server (REST API + static UI)
lib/config.js        port / paths
lib/store.js         in-memory board + atomic debounced save + label logic
lib/transcript.js    "last assistant message" extractor for the backstop
bin/status.js        the one CLI (hooks + Claude subcommands + ensure-server)
public/              index.html, app.js, styles.css  (self-contained UI)
data/                board.json, archive.json, server.port/pid/log  (runtime)
```

- **Active** cards live in `data/board.json`; **archived** (dumped) cards move to
  `data/archive.json`. Both are plain JSON you can inspect or back up.
- Writes are atomic (temp file + rename) and debounced, and a corrupt file is
  backed up rather than lost.

## Notes

- Loopback only (`127.0.0.1`) — not exposed to your network.
- The board polls every 3 seconds; drag cards between columns or use the buttons.
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
