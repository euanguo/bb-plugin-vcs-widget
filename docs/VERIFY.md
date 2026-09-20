# Live verification

`npm run check` covers the pure modules, the host against a temp repository
with a bare origin (including jobs, deadline, cancel and process-group kill,
the file watch through the harness), the server against bb's fake plugin
host, and the app under jsdom. This document is the click-through against a
running bb: `scripts/live-check.mjs` for milestone 1, `scripts/live-check-m2.mjs`
for milestone 2, `scripts/live-check-m3.mjs` for milestone 3,
`scripts/live-check-m4.mjs` for milestone 4, `scripts/live-check-m5.mjs` for
milestone 5, `scripts/live-check-m6.mjs` for the commit panel's later
additions, `scripts/live-check-m7.mjs` for the strip above the message box and
`scripts/live-check-m8.mjs` for what the popup and the commit panel cost on a
large repository, all on `scripts/live-lib.mjs`.

## Setup

```sh
bb plugin install . --yes      # once
bb plugin dev                  # terminal 1: rebuild + reload on save
bb plugin logs vcs-widget -f    # terminal 2
```

A scratch repository with a bare origin and a second clone, then a bb thread
whose environment is the scratch repository:

```sh
node scripts/live-check.mjs setup /tmp/vcs-scratch
# prints the git commands it ran; then create a thread on /tmp/vcs-scratch
# (a hidden thread keeps it out of the sidebar).
```

## Headless run

The script drives the bb web UI with system Chromium through puppeteer-core
and prints one PASS/FAIL line per scenario:

```sh
npm install --no-save puppeteer-core     # once; not a dependency of the plugin
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check.mjs run /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m2.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m3.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m4.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m5.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m6.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m7.mjs /tmp/vcs-scratch
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m8.mjs /tmp/vcs-scratch
```

Milestone 8 also takes `--read-only`, which measures the thread's repository
as it is and creates nothing:

```sh
VCS_E2E_THREAD=thr_xxx VCS_E2E_PROJECT=proj_xxx \
  node scripts/live-check-m8.mjs /path/to/a/worktree --read-only
```

Milestone 6 sends a real "LGTM - Commit" to `VCS_E2E_THREAD`, which starts a
turn on the scratch repository. It runs last, after the tree is clean, so the
agent it wakes has nothing to commit.

Milestone 5 also needs `bb` on `PATH`: it runs the plugin's own command
against `VCS_E2E_THREAD` and compares the output with git in the scratch
repository.

Environment: `BB_SERVER_URL` (default `http://127.0.0.1:38886`), `CHROMIUM`
(default `/usr/bin/chromium`). Screenshots land in `/tmp/vcs-e2e/`.

## Scenarios (manual or scripted)

1. Header: branch button left of bb's workspace buttons, label `main`;
   nothing renders on a thread without an environment; icon-only at phone
   width.
2. Open: search focused; Actions, Recent, Local (`main` current), Remote
   (`origin/feat/click-test`, `origin/feature`, `origin/main`); typing a
   remote-only name hides the empty Local heading; Esc closes; reopening
   starts unfiltered.
3. Checkout `origin/feat/click-test`: label follows, popup closes, tracking
   branch created, bb's sidebar follows within ~4 s.
4. New Branch: `bad name` disables Create with a hint; Escape in the form
   returns to the list; create with checkout switches; create without
   checkout keeps the popup open with "Created ...".
5. Update Project on a branch without upstream: `no_upstream` with hint; the
   next open still shows it, dated (`· 12 s ago`) with the repository summary
   underneath, and the status line is clean again a minute later.
6. Push on a new branch: dialog previews `git push --no-progress -u
   --end-of-options origin HEAD`; Cancel runs nothing; Confirm pushes and
   sets the upstream. A commit later, Push previews `git push --no-progress
   --end-of-options origin HEAD:refs/heads/<branch>` and the bare remote
   matches HEAD. Delete the remote branch from the second clone, Fetch: the
   "upstream is gone" banner shows and Push offers `-u` again.
7. `touch .git/index.lock`: opening the popup shows the lock banner at once,
   a checkout answers `index_locked` without running git; after removing the
   lock, reopening drops the banner and keeps the last outcome, dated. The
   refused click is not that outcome: a blocked row explains by toast and
   never writes the status line. Banners render inside the status region, so
   they are tagged `data-testid="vcs-banner"` to be read apart from it.
8. `git checkout --detach` in a terminal: label is a short sha, popup shows
   the Detached HEAD banner; `git switch main`: an open popup refreshes.
9. Update Project after a commit pushed from the second clone: "Update
   Project: Fast-forward."
10. Mod+Shift+P lists the seven `VCS Widget:` rows (bb adds a settings row);
    "Open branches" opens the popup; "Push..." shows the confirm dialog with
    the tracked refspec; a `vcs-widget:open` CustomEvent dispatched from the
    console with a `detail` opens nothing.
11. A second browser on the same environment refetches after a checkout in
    the first.
12. Compact viewport: icon-only button with an aria-label.
13. If an enrolled remote machine exists: repeat 3 to 9 on a thread there;
    the plugin log shows the host calls with that host id.

## Milestone 2 scenarios (`live-check-m2.mjs`)

1. Right-click `feature`: the sixteen IntelliJ rows in order, Rename with
   the F2 hint, Tracked Branch as a submenu.
2. The star on a row adds a Favourites group above Recent; it survives a
   reopen (server kv); unstarring removes the group.
3. Rename... opens the inline step prefilled; Enter renames.
4. Delete on an unmerged branch: dialog `git branch -d`, then a destructive
   second dialog `git branch -D` naming the lost commits; the branch is gone.
5. Tracked Branch ▸ `origin/feature` sets the upstream ("feature now tracks
   origin/feature").
6. Compare with 'main' opens a side panel tab titled `main ⇄ feature` with
   commit counts, two commit lists and the changed files.
7. Show Diff with Working Tree (after editing `a.txt`) opens a tab listing
   `a.txt`; clicking it renders the patch in bb's diff viewer.
8. Merge into main: dialog `git merge --no-edit --end-of-options
   refs/heads/<b>`, toast "Merged ... Fast-forward".
9. A conflicting merge: toast `Merge failed: CONFLICT (content): ...`; the
   reopened popup shows "A merge is in progress." with Abort, the menu's
   Checkout is disabled; Abort previews `git merge --abort`; afterwards the
   banner is gone and the tree clean.
10. Rebase current onto: dialog `git rebase --end-of-options refs/heads/<b>`.
11. Checkout Tag or Revision: the step lists tags; picking one previews
    `git switch --detach --end-of-options <tag>`; the label becomes a short
    sha; a detached banner shows.
12. New Worktree from `feature`: dialog `git worktree add --end-of-options
    <repo>-feature feature`; the directory exists on that branch; the row
    shows the worktree badge.
13. Fetch runs as a job: the plugin log has `fetch job <id> started` and
    `finished`.
14. Update on a branch that is not checked out fast-forwards it from its
    upstream.
15. Push... on another local branch previews `-u ... refs/heads/<b>:refs/heads/<b>`
    and creates it on the remote.
16. After a divergent commit on both sides, Push previews the tracked
    refspec; the "force with lease" switch changes it to
    `--force-with-lease=refs/heads/main:<sha>`; the remote ends at HEAD.
17. Delete on `origin/<b>` runs `push --delete` as a job.
18. Seven palette rows including Checkout Tag or Revision.
19. With an unreachable extra remote, Fetch hangs; Cancel in the status line
    ends the job with "Fetch was cancelled."

## Milestone 3 scenarios (`live-check-m3.mjs`)

1. The popup's Actions group has `Commit...` with the Ctrl+K hint; clicking
   it closes the popup and opens a "Commit" panel tab.
2. A clean tree says "Nothing to commit: the working tree is clean."
3. After an edit to `a.txt`, a staged edit plus a second edit to `b.txt`
   and a new untracked file (from a terminal), the panel lists Changes (2)
   and Unversioned files (1) with the status letters; the checkbox is the
   staged state: `a.txt` unchecked, `b.txt` mixed, the new file unchecked.
4. Ticking `a.txt` runs `git add` (status `M.`), unticking runs
   `git reset -q --` (status `.M`).
5. Selecting `b.txt` renders its patch in bb's diff viewer; the partially
   staged file offers Staged / Unstaged and the switch reloads the diff.
6. A message with a body and Commit: the toast names the sha and subject,
   `git log -1 --format=%B` holds the message exactly (it travelled on
   stdin), the box is cleared, `b.txt`'s unstaged part is still there.
7. With nothing staged the Commit button is disabled and the status line
   says "Nothing is staged: tick the files to include."
8. Amend prefills HEAD's message; Amend previews `git commit -F - --amend`;
   after confirming, HEAD's subject changed and its parent did not.
9. Discard on the untracked file previews
   `git --literal-pathspecs clean -f -- <file>`, the dialog says "delete 1
   file", Cancel keeps the file, Discard deletes it.
10. Discard on `b.txt` previews
    `git --literal-pathspecs restore --staged --worktree --source=HEAD -- b.txt`
    and reverts it; discarding `a.txt` too leaves the list empty.
11. With `core.hooksPath` pointing at a pre-commit hook that prints, sleeps
    3 s, prints again and exits 1: Commit shows "Committing…" with the
    hook's output line while the job runs, then "Commit failed: hook says
    no" (the hook's last line) and HEAD is unchanged. With Run Git hooks
    unticked the commit passes (`--no-verify`).
12. An edit and a `git add` from a terminal reach the panel without a
    click (the host watch on the git dir, bb's environment events).
13. Commit and Push commits, then the push dialog previews
    `git push --no-progress --end-of-options origin HEAD:refs/heads/main`;
    after Push the bare remote's `main` equals HEAD.
14. The palette lists eight `VCS Widget:` rows; "Commit..." opens the panel
    without opening the popup.

## Milestone 4 scenarios (`live-check-m4.mjs`)

1. The popup's Actions group has "Show Git Log" (Alt+9 hint); clicking it
   closes the popup and opens a "Git Log" panel tab.
2. The list shows the history newest first, and the tip carries its refs as
   badges: HEAD, the local branch, the remote-tracking branch.
3. The branch filter changes which refs are walked: a commit on another
   branch is in "All branches" and gone under "Current branch".
4. The message filter finds the commit by its subject; adding a regex
   character (`.`) finds nothing, because the filter is `--fixed-strings`.
5. Selecting a commit shows its full sha, message and changed files;
   selecting a file renders its diff in bb's viewer and Back returns to the
   commit.
6. The commit's context menu lists the seven rows; Cherry-Pick previews
   `git cherry-pick --end-of-options <sha>` and, after confirming, HEAD
   carries the picked subject.
7. Revert Commit previews `git revert --no-edit --end-of-options <sha>`;
   after confirming, HEAD is the revert and the file is gone again.
8. Reset Current Branch to Here → Hard is a destructive confirm previewing
   `git reset --hard --end-of-options <sha> --`; after confirming, the
   branch is back at that commit.
9. New Branch from a commit opens the branch form and creates the branch at
   that sha, checked out.
10. Compare with the current branch opens the compare tab with the commit as
    the target revision.
11. The palette row "VCS Widget: Show Git Log" opens the panel without the
    popup, and a commit made in a terminal appears in the open log without
    a click.
12. The palette lists eight `VCS Widget:` rows.

## Milestone 5 scenarios (`live-check-m5.mjs`)

1. `status` names the repository, the branch and its upstream.
2. `status` counts a dirty working tree (one unstaged, one untracked).
3. `branches --all` marks the current branch with `*` and lists the remote
   ones under their own heading.
4. `log --branch <name>` walks that branch and starts at its head.
5. `log --grep` is a literal filter: one commit, matched by subject.
6. `--json` prints bounded data: `branchCounts`, never the branch arrays,
   so a repository with thousands of branches cannot blow the CLI's output
   cap.
7. There is no mutating command: `checkout` is unknown. A usage error exits
   2, a thread with no repository exits 1 with the reason.
8. The settings page (`/settings/plugins/vcs-widget`) shows bb's own form
   plus both plugin sections.
9. "Agent access" names `bb vcs-widget status`, `vcs_widget_status` and the
   read-only promise.
10. "Favourite branches" lists the worktree whose branch the popup starred,
    and Clear empties it.
11. At 390 px the branch button is icon-only.
12. The popup stays inside the viewport at 390 px, as a bottom sheet.
13. The commit panel does not overflow at 390 px.
14. The log panel does not overflow at 390 px.

Manual, on top of the script:

15. The `vcs_widget_status` tool: ask an agent on a thread for the branch
    state; the row reads "Reading the git state" and the answer matches
    `bb vcs-widget status`.
16. `bb skill list` shows the `vcs-widget` plugin skill.
17. `bb plugin list --json` shows `statusDetail: null` with the `skill` and
    `agent-tool` capabilities: a rejected tool registration would say so
    there.

## Commit panel additions (`live-check-m6.mjs`)

1. The panel lists two tracked edits under Changes and one new file under
   Unversioned files.
2. Right-clicking a file row opens a menu of exactly Copy Path and Discard.
3. Copy Path runs and the panel reports the outcome. Headless Chromium
   denies `clipboard-write` whatever `overridePermissions` says — a plain
   button in the same page fails identically and
   `navigator.permissions.query({name:"clipboard-write"})` answers `denied`
   — so the script accepts "Could not copy the path." there. The successful
   copy is scenario 8 below, by hand.
4. Discard from the menu previews `git --literal-pathspecs clean -f -- <file>`,
   the dialog says "delete 1 file", and the file is gone from disk after it.
5. Only Changes and Unversioned files carry the header's Discard button;
   Conflicts does not.
6. The Changes header discards the whole group in one dialog: title
   "Discard changes in 2 files", one
   `git --literal-pathspecs restore --staged --worktree --source=HEAD --`
   naming both paths, and `git status --porcelain` is empty afterwards.
7. Both agent buttons read "Agent Commit" and "Agent Commit & Push", carry
   the Sent icon and are enabled with nothing staged and no message. Only the
   first is clicked: it puts a User message reading "LGTM - Commit" in the
   thread's event log (`bb thread log`), and the panel says it was sent or
   queued. Clicking the second would tell a real agent to push, and the only
   thing it would add is that the variant picks the other row of
   `AGENT_ACTIONS`, which `server.test.ts` proves against that same table.

Manual, on top of the script:

8. The three clipboard copies in a real browser window (COS-142). Copy Path
   on a file row pastes the repository-relative path and the panel's own
   status line says "Copied <path>". Copy Branch Name on a branch row pastes
   the branch name, `origin/<branch>` on a remote row, and toasts
   "Copied <name>". Copy Revision Number on a log row pastes the full
   40-character sha while the toast names the short one, as IntelliJ does.
9. A group whose paths would outgrow one call (500 files, or long paths over
   256 KB of argv) is refused before the dialog with "Too many files for one
   discard."
10. Clicking "Agent Commit" while the agent is mid-turn says the message is
    queued, and the agent takes it when the turn ends.
11. "Agent Commit & Push" on a thread whose repository has an upstream and one
    unpushed commit: the event log shows "LGTM - Commit & Push", the panel
    quotes that text back, and the agent commits and pushes. This is the
    scenario the script will not run for you.
12. Hovering either agent button explains it: "Sends “LGTM - …” to this
    thread's agent, as if you had typed it. Runs no git here."

## Composer banner scenarios (`live-check-m7.mjs`)

On the same scratch thread, with the tree clean to start.

1. Nothing above the message box while the tree is clean.
2. Editing a tracked file and adding a new one brings the banner up on its
   own, without a click anywhere: the file watch the first overview registered
   is what pushes it. It reads "main" and "2 to commit".
3. Hovering the count breaks it down: "1 unstaged, 1 untracked". Untracked
   files count here, unlike the check a checkout runs.
4. Both buttons read "Agent Commit" and "Agent Commit & Push", are enabled,
   and their accessible name ends "Runs no git here."
5. Restoring the file and deleting the new one takes the banner away again.

Manual, on top of the script:

6. Clicking either button from the banner. The script will not: this banner
   only exists over a dirty tree, so a click here wakes the thread's agent
   with something real to commit. The event log (`bb thread log`) shows the
   line, and a toast quotes it back — the same `sendToAgent` the panel's
   buttons use, which `server.test.ts` covers against `AGENT_ACTIONS`.

## What the popup and the panel cost (`live-check-m8.mjs`)

The other milestones check that the surfaces work. This one checks that they
stay cheap when a thread's worktree holds hundreds of branches and hundreds of
changed files, and it is the only script that reports numbers rather than pass
or fail alone: every step prints what it measured next to its budget.

Without `--read-only` it makes its own fixture in the repository it is given —
300 branches and 400 untracked files, removed again on the way out — so **never
point it at a repository you care about**. With `--read-only` it creates
nothing at all, which is how it is run against a real thread.

Step 11 is the exception to "a synthetic fixture proves it": the cost it guards
against only appears when a real diff is mounted, because it is the browser
re-wrapping that diff. It turns the wrap toggle on for the length of the check
and puts the reader's preference back afterwards, and it prints the numbers
either way.

No step clicks a branch row, stages a file or commits. It measures by reading
the DOM and by timing work in the page itself: one `PerformanceObserver` per
stretch of interaction and a `requestAnimationFrame` loop for frames, with the
splitter driven by pointer events dispatched inside the page. A driven *mouse*
is not used on purpose — against this page it costs about a second a frame on
its own, which is an artefact of the harness rather than of the plugin, and
measuring with it once produced a confident and entirely wrong answer.

Measured against `tea-app-im` (210 local and 200 remote branches, 459 changed
files) on 2026-09-18, before and after the windowing:

| | before | after | budget |
|---|---|---|---|
| rows the popup renders | 425 | 24 | 40 |
| popup open, main-thread work | 820 ms | 0 ms | 400 ms |
| one keystroke in the search box | 66–192 ms | 2–18 ms | no long task |
| rows the changed-file list renders | 502 | 32 | 80 |
| nodes in the commit panel | 11 346 | 5 108 | 6 000 |
| a twenty-step splitter drag | 1 912 ms | 0 ms | 500 ms |
| storage writes in that drag | one per pointermove | 1 | 1 |
| average frame during that drag | 70 ms | 17 ms | — |

And the one that is not about this change at all, found afterwards by reading
the report of a reader whose diff is 2000px tall: **a width change with
`overflow: wrap` costs about 180 ms** against 0-1 ms with `overflow: scroll`.
The renderer lays a wrapping diff out as a grid whose two columns each span
every row, so each change re-wraps the whole diff and re-solves that grid; the
library has no option for it (`ResizeManager` only writes column-width
variables). Sixty width changes, no input involved:

| sixty width changes, wrap on | before | after |
|---|---|---|
| median frame | 180 ms | 17 ms |
| frames over 33 ms | 59 of 60 | 1 of 60 |
| total | 10 913 ms | 1 298 ms |
| long tasks | 33 390 ms | 431 ms |

The plugin now pins the diff's own width for the length of a resize and releases
it when the resize settles, so the content re-lays-out once at the end instead
of once a frame. It applies only in wrap mode: with scrolling lines the content
follows the drag exactly as it always did, at no cost.

## Last run

2026-09-09, bb 0.42.1, git 2.55, one local machine: milestone 1 scenarios
1 to 12 (27 steps), milestone 2 scenarios 1 to 19 (21 steps), milestone 3
scenarios 1 to 14 (16 steps), milestone 4 scenarios 1 to 12 (12 steps) and
milestone 5 scenarios 1 to 14 pass headlessly (see the COS-121 to COS-125
comments). Scenario 13 of milestone 1 waits for a remote machine (COS-126).
The milestone 1 push step once failed to reopen the popup after a cancelled
dialog and passed on the rerun (COS-127). It has not happened since. `openPopup`
now prints the DOM state instead of a bare timeout when it does: whether the
button is reachable by a hit test at its own centre, what element is there
instead, `document.body`'s pointer-events, the active element, any
`aria-hidden` or `inert` ancestor, and every open dialog and popper layer with
its `data-state`. It also writes a screenshot. Radix reaches the plugin through
bb's shared runtime (`globalThis.__bbPluginRuntime`), not a bundled copy, so
the layer bookkeeping that owns `pointer-events` is one instance across bb and
the plugin, and split module state is not the explanation.

2026-09-18, bb 0.43.2-nightly, git 2.49, one local machine: the performance
milestone passes headlessly, all twelve steps, against a real thread's worktree
(`tea-app-im`, 210 local and 200 remote branches, 459 changed files) in
`--read-only` mode. Its numbers are the table above. The same day, `npm run
check` was green at 514 tests over 22 files, of which 83 are the app's under
jsdom and now include the popup's window, the changed-file list's window, and
one storage write per splitter drag. Milestones 1 and 3 were **not** rerun
against a scratch repository: they need a thread whose environment is one, and
that thread does not exist on this machine. They are the first thing to run
after creating one.

The commit panel additions (six scenarios) pass headlessly on the same
machine, 2026-09-09, and milestone 3 was rerun whole against the restructured
file row: 16 of 16. Scenario 3 found that Copy Path cannot be verified
headlessly at all: Chromium denies the clipboard write to any page in that
mode, the plugin's own code is not involved, and the same limit applies to
Copy Branch Name and Copy Revision Number, which no script covers either.
Scenario 7 first looked for the message in `bb thread history`, which
collapses identical prompts, so a second run saw no new message; it reads the
thread's event log now.

Scenario 8 was hand-checked in a real browser window on 2026-09-09 and all
three copies pass: the pastes are the repository-relative path, the branch
name and the full 40-character sha, and each surface reports where it
reports — the commit panel on its own status line, the popup and the log by
toast. Nothing in the plugin needed changing; the headless denial really was
Chromium's.

The two agent buttons of COS-143 were hand-checked on 2026-09-09 and pass
(COS-144): the Sent glyph renders, the wrapper span's tooltip appears on
hover, and "Agent Commit & Push" reaches the agent as "LGTM - Commit & Push".
Scenarios 11 and 12 stay by hand: the script reads that button rather than
pressing it, because pressing it tells a real agent to push.

Milestone 5's first run failed on the settings page because it looked for it
at `/extensions/plugins/<id>`, which is the marketplace page; the plugin's
settings live at `/settings/plugins/<id>`. It also could not reopen the
popup behind an open panel tab at 390 px, so each panel check now starts
from a reloaded thread page.

Milestone 4 first ran with milestone 2 stopping at scenario 10: the log row
made the branch context menu one row taller, so it no longer fitted below
the pointer, an item ended up under it, and the release of the right-click
that opened the menu ran that item (Radix clicks an item on a pointerup it
saw no pointerdown for). `components/ui/context-menu.tsx` now ignores that
release; the whole suite passes again.

The composer banner's five scenarios pass headlessly on 2026-09-13, bb 0.43.0,
git 2.55, the same machine. Scenario 2 is the interesting one: nothing clicks,
the file watch does it. Scenario 3 first failed on the script rather than the
plugin — `[title]` inside the banner matched the branch, which carries its own
tooltip, so the count element names itself now.
