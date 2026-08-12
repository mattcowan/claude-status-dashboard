---
description: Post this session's current status to the Claude Session Dashboard
argument-hint: [optional note, e.g. "blocked on API keys"]
---
Post an up-to-date status for THIS session to my local Claude Session Dashboard
(the board at http://127.0.0.1:4787) so I can see what you're doing from the
board. Do it now, based on the actual state of our work in this session.

1. Write a **one-line headline** naming what this session is doing, and a
   **1–3 sentence description** of the current state (what's done, what's in
   progress). If the task has several parts, you may use `-` bullet lines in the
   body.
2. Choose the column that reflects where things ACTUALLY stand right now:
   - Actively mid-task / more work to do → **Working** (`set`)
   - Blocked on me, or waiting for my input/decision → **Needs Input** (`needs-input`)
   - Finished and ready for my review → **Ready for Review** (`done-for-review`)
3. Post it with the dashboard CLI. It auto-starts the dashboard if it's down and
   identifies this session automatically (via `CLAUDE_CODE_SESSION_ID`), creating
   the card if one doesn't exist yet — so just run the one command that matches
   your chosen column, from THIS session's working directory:

   - Working:
     `node "<DASHBOARD_PATH>/bin/status.js" set --headline "…" --body "…"`
   - Needs Input:
     `node "<DASHBOARD_PATH>/bin/status.js" needs-input --headline "…" --body "…"`
   - Ready for Review:
     `node "<DASHBOARD_PATH>/bin/status.js" done-for-review --headline "…" --body "…"`

Do NOT mark anything "Done" — that column is mine alone. After posting, reply in
one line telling me which column you used and the headline. If I added a note
below, factor it into the status.

$ARGUMENTS
