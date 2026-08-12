# CLAUDE.md snippet

**This is the half of the install that the hooks can't do.**

The hooks create and move cards on their own. They cannot write a *headline* —
only Claude can say what it is actually working on. This block is what tells it
to. Without it you get a board of correctly-placed cards that all say nothing,
each stamped **⚙ auto-captured** because Claude never declared an outcome.

Paste it into your **`~/.claude/CLAUDE.md`** (applies to every project) or a
project's own `CLAUDE.md` (that project only), replacing `<DASHBOARD_PATH>` with
the absolute path to your clone.

Everything below the line is the snippet.

---

## Claude Status Dashboard

A local Kanban board tracks the status of **every Claude session** so I can
manage several at once (`http://127.0.0.1:4787`, app at `<DASHBOARD_PATH>`).
Your session is auto-registered in the **Working** column when you send your
first message (UserPromptSubmit hook), tagged with this project folder. Keep its
card current — it's how I know what you're doing:

- **At the start of substantive work**, set a one-line headline + short description:
  `node "<DASHBOARD_PATH>/bin/status.js" set --headline "…" --body "…"`
- **As the task sprawls** into sub-parts, append bullets instead of rewriting the body:
  `node "<DASHBOARD_PATH>/bin/status.js" note --bullet "…"`
- **When you finish the turn, declare the outcome** so the card lands in the right column:
  - Blocked on me / need a decision → `node "<DASHBOARD_PATH>/bin/status.js" needs-input --body "what you need from me"` (**Needs Input**)
  - You believe it's ready for my review → `node "<DASHBOARD_PATH>/bin/status.js" done-for-review` (**Ready for Review**)
- You normally **don't** pass `--session` — the CLI identifies your card
  automatically from `CLAUDE_CODE_SESSION_ID` (and falls back to this folder).
- If you set no status, a **Stop-hook backstop** captures where you left off and
  moves the card to Needs Input, flagged `⚙ auto-captured`. Setting it
  deliberately is better — the backstop is only a safety net.
- **Never mark cards "Done"** — that's mine alone. Files you edit outside this
  folder are flagged on the card automatically.
- This is lightweight bookkeeping, not a reason to over-report: a `set` at the
  start and a `needs-input`/`done-for-review` at the end is the norm; add `note`
  bullets only when a task genuinely grows.
