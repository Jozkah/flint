# Mobile: the phone app and the Android build

Two different things are called "mobile" in this repo. Keep them apart.

## The phone app ("remote")

`web-app/mobile.html` + `web-app/src/mobile/**` is a separate Vite entry (`vite.mobile.config.ts`, `yarn build:mobile`, output `src-tauri/resources/mobile`). The desktop's remote-access server (`src-tauri/src/core/remote`, started by `flint serve` or the desktop app) serves it at `https://<computer>:1340/m/`. A paired phone installs it as a PWA (`mobile-public/manifest.webmanifest`, push through a service worker in `src/mobile/sw`) and reaches the computer directly, over Tailscale or any route to that port.

How it works:

- Pairing: a code on the computer, confirmed there, gives the phone a bearer token (`api/client.ts`, `state/pairing.ts`).
- Calls: `POST /remote/v1/rpc {id, method, params}`. The Rust server checks the token and the approvals switch, then emits `remote://rpc` to the desktop window, which runs the method in TypeScript (`lib/remote/bridge.ts`, `handlers.ts`, `app*.ts`) against the same stores and Tauri commands the desktop UI uses, and answers through `remote_rpc_respond`. There is no method allow-list in Rust: the handler map in TypeScript is the allow-list (an unknown name answers `unknown_method`). The Rust side only gates names that start with `approvals.` on "Approvals from phones" (and `scope: "always"` on "Always allow from phones") in `hub.rs::check_policy`.
- Events: a WebSocket (`/events`) carries approvals, run state and reply streams; Web Push covers a hidden page.
- So the agent loop, safety checks, redaction and worktrees run on the computer, in the same Rust loop for a phone's session as for a desktop one. Anything a phone does is a desktop action with the phone as the remote control.

The phone app has: Chat, Cowork sessions, Rooms, approvals, questions and prompts (cards and push actions), models and Hugging Face, Library, Studio, Archive, System, Tools, settings and pairing.

## The Android build (.apk)

`yarn build:android` (`package.json`, `src-tauri/tauri.android.conf.json`, `tauri-plugin-*` built with `--no-default-features --features mobile`) is Tauri Mobile around the main desktop web app with `IS_ANDROID=true`. It is not the phone app above. It has no remote server (`core::remote` is not compiled on android/ios), no agent tools plugin, no worktrees and no local inference (`lib/platform/const.ts`). Cowork and Campaigns need all of those, so they do not run in that build. Nothing in the repo packages the phone app into an APK; the phone app is installed from the computer's page. To use campaigns from an Android phone, pair it with the computer and open the phone app (PWA).

## Parity with desktop

| Desktop change on this branch | Phone app | Android build |
| --- | --- | --- |
| Campaigns: list, board, headline, grouped tasks, per-task files, plan and task approvals, pause, resume, cancel, review and apply | Ported: Cowork menu, Campaigns (`screens/Campaigns.tsx`, `Campaign.tsx`) over `campaigns.list`, `campaigns.get`, `approvals.campaign.act` | N/A (no agent backend) |
| Starting a campaign ("New campaign") | Not ported on purpose: it needs a folder picker and git check on the computer; ask for it in a Cowork chat (the model has `campaign_plan`) | N/A |
| Single status dot per campaign row | Done in the Campaigns list (one dot: attention, moving, quiet) | N/A |
| Approval attention mark on a session | Had it: a waiting dot and shield on the session row, an approvals pill in the top bar | N/A |
| Context ring toggle card | Had it: the ring opens the Context window sheet (a sheet, not a hover card; hover is N/A on touch) | N/A |
| Chat / Cowork sidebar tabs, Resume and usage, folded More | N/A: the phone's drawer already groups Cowork, Rooms and chats; no sidebar to split | N/A |
| Discover: Hugging Face mark, quiet link, plain task chips | Chips ported (`lib/hubTasks.ts` reused); the mark and header link are desktop chrome | N/A |
| New window, pane tabs, desktop sidebar | N/A | N/A |
| Stale-edit guard, destructive-command prompts, secret redaction, hook and verification changes | Apply automatically: same Rust loop and approvals; prompts reach the phone as approval cards | N/A |

Not verified on a device: the phone UI was built against the same fixtures as the other phone screens (vitest, jsdom). Layout on a real phone, push taps and the live data path through `https://<computer>:1340` need a manual pass, see "Verify" below.

## Verify

1. On the computer: `yarn build:mobile` (or `yarn build`), start Flint, turn on Remote access, keep Approvals from phones on.
2. Pair the phone (scan the QR or open `https://<computer>:1340/m/#pair=...`), open the drawer: Cowork, then Campaigns.
3. With a campaign running on the computer, the list shows its headline; open it and check the groups, the file counts and the approval card for the plan. Pause then Resume; both show in the desktop board within a few seconds.
4. When the campaign is ready, Check and prepare changes, then Apply: the files land in the project folder; flagged files stay locked until ticked.
5. Turn Approvals from phones off on the computer: every campaign action answers "turned off on the computer", and the list stays readable.
6. Open Discover (Hugging Face) from the phone: the task chips narrow the list.

## Using the .apk with a headless Flint server

Requirement: "Cowork and Campaigns should run on the .apk when it connects to a headless server." What is built, and what is not, as of this branch:

**Built.** The Android build can open a `flint serve` instance. The server serves the same web app over HTTPS and that page already talks to the server (`lib/tauriBridgeShim.ts`: `invoke` becomes `POST /api/v1/rpc/<command>`, events arrive over `/api/v1/events`, provider calls over `/api/v1/provider/stream`). Opening the server is therefore the whole "route backend calls to the server" step; there is no second transport in the bundled app. Chat, rooms, models, MCP servers and the other pages the browser build supports run on the server, with the apk as the screen.

**Not built: running a Cowork session or a campaign task on the server.** Three facts block it (see "What blocks agent runs on a headless server"). The .apk and a browser both show the Cowork and Campaigns pages, but a session started from them cannot execute tools. Run sessions and campaigns on a computer with Flint open and reach them from the phone app (pairing, above).

### Set up

1. On the always-on machine, start the server. A TLS proxy in front is required for anything beyond loopback; Tailscale Serve is the usual one:

   ```
   flint serve --listen 127.0.0.1:1340 --public-host flint.<tailnet>.ts.net --agent-root ~/code
   ```

   `--agent-root <folder>` is optional and repeatable. It turns on the review plane described below for projects under that folder. A root may not contain the data folder (the server refuses to start if it does).
2. Copy the first-run administrator credential the server prints (shown once; `flint serve --background` leaves it for the starter to show).
3. Make the address reachable from the phone (Tailscale on, or the VPN you use) and open it once in the phone's browser to check the certificate is trusted. Android's WebView offers no way past an untrusted certificate, so a self-signed one will not work.
4. In the .apk: Settings, General, **Flint server**. Enter the HTTPS address, **Test connection**, then **Open server**. Sign in on the server's own page with the credential. Optional: turn on **Open at start**; the app then shows a four second countdown at launch with a **Use this device** button.

### Verify

1. Test connection says "Reached a Flint server." (If it says something answered but could not be confirmed, the server was not started with `--allowed-origin` for the app; Open server still works.)
2. After signing in, the chat sends a message and the model answers through the server's providers.
3. `POST /api/v1/rpc/agent_server_info` (curl with a bearer token from `POST /api/v1/token`) returns `{"agent":true,"folders":[...]}` when `--agent-root` was given, and `{"agent":false}` otherwise.
4. In a browser or the apk, the Campaigns page lists campaigns recorded in the server's data folder, and a proposal for a project under the root can be reviewed, applied or rejected.

### How the credential is kept

The app stores the server **address** and the Open-at-start switch (this origin's local storage), nothing else. The administrator credential is typed on the server's page; the session is the server's `flint_session` cookie (12 hours, HttpOnly, SameSite=Strict, Secure over HTTPS) in the WebView's cookie jar. No token is written to settings, logs or the keyring by the app. A native-shell client that prefers a bearer token can use `POST /api/v1/token` with `--allowed-origin <the app's origin>`, which the server already supports and tests.

### The review plane (`--agent-root`)

Off by default. When on, a signed-in client may call these commands over `/api/v1/rpc/`, and only these:

| Command | Does |
| --- | --- |
| `agent_server_info`, `agent_server_folders` | Capability, and a browse of the allowed folders (names only, no file reads) |
| `agent_campaign_list`, `_get`, `_context`, `_events` | Read campaign records, decisions, handoffs and the event log |
| `agent_run_list`, `agent_run_get` | The sessions an agent wrote in the server's data folder (only those whose folder is under a root), and one transcript. Read-only |
| `GET /api/v1/agent/sessions/<id>/events?after=<seq>` | Event replay of one session as server-sent events, resumable with `after=` or `Last-Event-ID` |
| `agent_campaign_transition` | Pause, resume (from paused only) and cancel a campaign. Task moves, plan approval and an integration worktree from a client are refused |
| `agent_campaign_cancel` | Cancel |
| `agent_proposal_list`, `_apply`, `_reject` | The stored, hash-approved proposal path. The destination is the stored proposal's project, which must be under a root |

Every path is canonicalized and must sit inside a root. Nothing here spawns a process, runs a build or test, merges, discards a worktree or executes a tool. Every call needs the bearer token or session cookie like any other server call; the same-origin and host checks apply.

### What blocks agent runs on a headless server

1. **No tool executor in the headless build.** `execute_tool`, the write grants and the sandbox status live in `tauri-plugin-agent-tools` behind its `tauri` feature, which the `flint` binary leaves out on purpose (no GUI stack in the graph). The browser transport has no way to call them, and `Channel` streaming is not available in `tauriBridgeShim`.
2. **The Cowork loop and the campaign scheduler are renderer code** (`coworkRunner.ts`, `campaignRunner.ts`, `campaignHost.ts`). `useMailboxDelivery` returns early when there is no Tauri bridge, so the campaign host is not even started in the browser build. Moving the loop to the apk's WebView would run the model calls on the phone and leave the tools on a server that cannot run them.
3. **Roughly eighty `agent_*` and `plugin:agent-tools|*` commands** back a Cowork session and the board (worktrees, mailbox, checkpoints, skills, memory, access). The server answers none of them except the review plane above.

The way through, and the real work, is a server-side runner. The Rust loop (`core::agent::loop`, `core::cli::rpc` sessions) already runs turns headless, `campaign_scheduler::next_actions` is a pure function, and P7 in `docs/CAMPAIGNS.md` names the durable worker. It needs HTTP endpoints for start, steer, stop, approvals and an event stream, and a UI mode in which Cowork drives that instead of the renderer loop.

### The server runner: phases and security model

Decision: the Rust loop on the server (`core::agent::loop`, the `core::cli::rpc` session machinery) is the accepted Cowork runtime for a headless server. The desktop keeps its TS loop; a phone or .apk WebView at the server's address drives the server's loop through a client adapter. Parity gaps are labelled in the capability probe (`parityGaps`) and not hidden: plan-review UX, goal evaluation, TS-side compaction, agent teams, and the browser and computer panes.

| Phase | What | State |
| --- | --- | --- |
| P0 | `--agent-run` flag, capability probe, read-only session list, transcript and event replay, client probe and banner | Landed |
| P1 | Session runner: create, start, steer, interrupt, approvals and questions over HTTP with a live per-session event stream; the Cowork adapter for one session (`remoteCowork.ts`) and a "Run on server" entry | Landed (single Cowork-style session) |
| P2 | Worktrees and proposals for server sessions: an isolated, server-owned checkout per writing session, `agent_worktree_*` commands by session id, a proposal after each turn that changed something, the worktree panel on the page | Landed (model and mode pickers still missing) |
| P3 | Campaign tasks and verification on the server | Not built |

`flint serve --agent-run --agent-root <folder>`: the flag needs at least one root, or the server refuses to start. `agent_server_info` reports `runRequested`, `sandbox`, `enforces`, `roots`, `maxSessions`, `allowBypass`, `allowAlways`, `approvalTimeoutSecs`, `liveSessions` and a `missing` list in words (for example "install bubblewrap"). `runsSessions` is true only when the flag is on, the runner is built, and the command sandbox (`tools::jail` backend) enforces; `--agent-require-sandbox=false` is the operator's explicit way to run unsandboxed anyway.

Operator switches (all off or conservative by default):

| Flag | Default | Effect |
| --- | --- | --- |
| `--agent-max-sessions <n>` | 4 | Live sessions at once; a create past it is refused with 429. A session nobody touched for 30 minutes leaves memory (its thread is on disk and the next start resumes it). |
| `--agent-allow-bypass` | off | Without it a session is `read` (plan mode) or `ask` (writes, shell and MCP prompt); `auto` and `bypass` are refused with 403. |
| `--agent-allow-always` | off | Without it an approval covers one call, and the server tells the client not to offer "allow always". |
| `--agent-approval-timeout <secs>` | 1800 | An unanswered prompt is denied, audited as `by: timeout`, and the turn goes on. |
| `--agent-require-sandbox[=false]` | true | Sessions run only under an enforcing command sandbox. |

### What P1 does

Commands, over `POST /api/v1/rpc/<command>` behind the same sign-in, same-origin and host checks as everything else, and refused unless `--agent-run` is on and the probe is ready:

| Command | Arguments | Result |
| --- | --- | --- |
| `agent_run_create` | `folder` (inside a root), `access` (`read`, `ask`; `auto`/`bypass` need the flag), `mode` (a label, default `cowork`), `model`, `title` | `{ id, folder, model, access, status }` |
| `agent_run_start` | `id`, `input` (text or content parts, within the stdio protocol's caps) | `{ turnId, after }`. One active turn per session (409); 20 turns a minute (429). A stored session that is not live is resumed first. |
| `agent_run_steer` | `id`, `text` | Delivered at the loop's next safe point. |
| `agent_run_interrupt` | `id` | Aborts the turn, denies pending prompts, persists what the turn had, emits `done{stop_reason: "cancelled"}` then `turn.completed{stopReason: "interrupted"}`. |
| `agent_run_approve` | `id`, `requestId`, `decision` (`allow_once`, `deny`, `allow_always` if enabled) | The request id must belong to that session and still be pending (404 otherwise). Audited in the session's event log (`permission.decided`: request, tool, decision, a digest of the client and of its address). |
| `agent_run_answer_ask` | `id`, `requestId`, `results` | Validated against the question before it is delivered. |
| `agent_run_set_model`, `agent_run_set_mode` | `id`, `model` / `access` | Refused while a turn is active (409). |
| `agent_run_delete` | `id` | Only sessions this runner started. |

`agent_run_list` and `agent_run_get` (P0) lay the live state over the stored row: `live`, `status` (`idle`, `running`, `awaiting_approval`, `awaiting_answer`), `access`, `pendingApprovals`, `pendingAsks`, `lastSeq`, `turnAfter`.

The event stream, `GET /api/v1/agent/sessions/<id>/events?after=<seq>` (and `Last-Event-ID`): for a live session the response is replay from a 4096-event ring, then the live tail, with a `: keepalive` comment every 15 seconds and no end until the client leaves or the session closes. Each record is `id: <seq>` and an envelope `{ seq, source: "live", kind, at, payload }`:

- `kind: "stream"`: the Rust loop's `StreamEvent` unchanged (`token`, `tool_call_started`, `tool_call_args_delta`, `tool_call`, `tool_result`, `permission_request`, `ask_request`, `todo_update`, `subagent*`, `done`, `error`, ...), except that the full-history `messages_updated` is never sent.
- `kind: "turn.started"` (with the message the turn answers), `turn.completed` (`stopReason`: `completed`, `interrupted` or `error`), `approval.resolved` (with `by`, so a prompt answered on another device or by timeout disappears), `ask.answered`, `steer.queued`, `session.model`, `session.access`, `session.closed`.
- Named events before the data: `hello` (status, seq, waiting prompts), `gap` (the ring no longer holds what the cursor needs: refetch the transcript with `agent_run_get`), `reset` (the cursor is from an earlier life of the session, after a server restart: events start over).

A session that is not live falls back to the P0 finite replay. Every payload passes the shared secret redaction on its way out. Coarse pings go on `/api/v1/events`: `agent-session-changed` and `agent-approval-pending`.

Where the data lives: the thread (`<data>/threads/<id>`) is written at create and after every turn with `source: "runner"`, `folder`, `access` and `mode` in its metadata, so a restarted server lists it and can resume it. The agent loop's own event log (`<data>/events`) holds the durable record. These threads also appear in the web app's ordinary thread list.

On the page: `lib/remoteRunner.ts` is the wire client (including `subscribeRun`, which reconnects with the last seq and treats a silent connection as dead). `lib/remoteCowork.ts` maps the stream into the stores Cowork reads (`useCoworkRun`, `useCoworkSessions` rows with `remote: true`, `useToolApprovalRequests`, the subagent feed), so the transcript, Stop, question cards and steering from the composer work unchanged; the server's prompts are raised directly and answered over the wire, never by this window's standing grants or permission mode. The sessions list is read through from the server and a remote row is saved without its transcript. The entry is the "Server agents" card in Settings, General.

Security model, which P1 must keep:

- Confinement: every session's folder must resolve inside an `--agent-root`; the data folder is never a root. A session that records no folder is not listed.
- Sandbox required: commands run only under an enforcing backend (bubblewrap, seatbelt, AppContainer). With none, `bash` is withheld rather than run unconfined, and `runsSessions` is false.
- Approvals: the server never auto-approves a prompt in `read`/`ask`; an unanswered one is denied at the timeout, with the decision recorded.
- Same auth as the rest of the server: bearer token or session cookie, same-origin and host checks.
- A remote session gets the built-in tools only: no MCP server is connected for it and no host tool is declared. (P2: a session that may write works in its own worktree; see below.)

What the P0 transcript does not carry yet: reasoning, tool images, subagent runs, goal state, plan snapshots, compaction dividers, per-turn usage (the response lists them in `notMapped`).

### What P2 does: worktrees and proposals

A session that may write (`ask`, `auto`, `bypass`) and whose folder is inside a git repository runs in an isolated checkout by default; `read` sessions and non-repositories run in place. `agent_run_create` takes `worktree` (`false` opts out, `true` insists and fails with 422 outside a repository) and `base` (a local branch or commit to start from; the "Merge" target). The checkout is made with `core::agent::worktree::ensure_with` under the **server's** folder (`<data>/agent-workspace/worktrees`), never a client-supplied path; the branch is `flint/<title>-<short id>` (or `jan/cowork/<id>` without a title). The thread's `metadata.worktree` stores the record (`path`, `branch`, `baseSha`, `baseBranch`, `sourceRoot`, `identity`, `notes`), and `agent_run_list|get` and the create answer show a short form. The thread's `folder` stays the source folder, so listing and confinement behave as before; the session's tools work in the checkout (the same subfolder of it, when the folder was below the repository top).

| Command | Arguments | Result |
| --- | --- | --- |
| `agent_worktree_state` | `id` | `{ state, worktree, project }`; `state` is `ready`, `missing`, `corrupt`, `branch-moved` or `identity-changed` |
| `agent_worktree_pending` | `id` | `{ files }`: uncommitted files |
| `agent_worktree_unmerged` | `id` | `{ commits }`: on the branch, not in the base |
| `agent_worktree_commit_pending` | `id`, `message` | `{ committed }` (hooks skipped, `.jan/` never included) |
| `agent_worktree_merge` | `id`, `target`, `commitMessage` | `MergeOutcome`; conflicts are found with `git merge-tree` before anything moves; uncommitted work refuses unless `commitMessage` commits it first |
| `agent_worktree_rename` | `id`, `title` | `{ worktree }` with the branch renamed |
| `agent_worktree_discard` | `id`, `force` | `{ discarded }`; refuses uncommitted or unmerged work without `force`; the live session ends and cannot be resumed (`worktreeDiscarded: true` on the row) |
| `agent_worktree_list` | `project` (confined) | `{ worktrees }`: Flint's worktrees of that repository |

Every command names the session. A path or record in the request is ignored: the record is read from that session's stored thread, so a client cannot point a merge or a discard at anything it did not start. On a live session the operation runs on the session's actor (serialised with turns; a state-changing one is refused with 409 while a turn is active).

Proposals: when a turn ends (or is interrupted) and the worktree differs from its base commit, the server stores the change with `proposal::create` (scope `session`, `project` = the repository top level, `worktree` = the checkout), rejects the session's earlier pending proposal as superseded, and emits `proposal.created` (`proposalId`, `files`, `additions`, `deletions`) before `turn.completed`. A turn that left the same content as the last proposal makes no new one. A change the server cannot propose (a path through a link, a worktree that is not `ready`) emits `proposal.error` instead. Review is the existing plane: `agent_proposal_list` (by `project`), `agent_proposal_apply` (hash-approved approval; the destination is the stored proposal's project, confined to the roots) and `agent_proposal_reject`. Nothing reaches the source folder before an approval or an explicit `agent_worktree_merge`.

On the page: `components/server/RemoteWorktreePanel.tsx` (mounted in the Cowork diff rail for a remote session) shows the branch, state and counts, "Merge into <base>" (commits pending work, then merges), "Discard" (asks first, names what it removes), the file list of the pending proposal and the ordinary `CoworkProposalReview` for apply and reject. "Run on server" gets an "own checkout" option for git folders (on by default, off is the explicit opt-out).

Operator switch: `--agent-allow-checks` (default off) is reported as `runsChecks`. P2 has no runner for a project's own commands, so nothing is gated on it yet; it is the switch P3's verification checks and gate will need. `runsWorktrees` in `agent_server_info` says the capability is built.

Security notes (P2):

- The worktree root is the server's own folder. Creation refuses a repository whose top level is not inside an `--agent-root`, a base that starts with `-`, and a worktree that would sit inside the repository.
- A stored record is trusted for nothing. Before every use it must still be listed by its repository's own git at that path on a Flint branch under the owned root (`worktree::ensure_owned`), and its repository must resolve inside a root. A forged `path` or `sourceRoot` in the thread file gets 403 on every operation (covered by `tests/web_agent_run.rs`).
- Resuming a session after a restart re-validates the record and the worktree state; a worktree that is missing or moved refuses the start (409) instead of writing somewhere else.
- A changed path that is, or passes through, a link out of the checkout stops the whole proposal (`ChangesError::LinkEscape`); the content is read from inside the checkout only.
- State-changing commands are audited in the session's event log as `worktree.commit_pending|merge|rename|discard` with the digests of the client and its address (never the token), and proposal create/apply/reject are audited by the proposal store.
- Merge writes into the source repository: a fast-forward of the base branch moves the files of the checkout that has it checked out (refused when that checkout is dirty or mid-operation), otherwise only the ref moves. It is an explicit, signed-in client action; there is no automatic merge.
- Commit is made with hooks skipped. Git itself still runs for creation (`worktree add`), `merge --ff-only` and `worktree remove`, so the repository's own `post-checkout` and `post-merge` hooks can fire; they are the operator's repository's own scripts, run outside the command sandbox. A repository whose hooks must not run on the server should not be an `--agent-root`.
- `.jan/` (the session's own scaffolding inside the checkout) is added to the repository's local `info/exclude` once, so it is never committed, merged or proposed. That touches one unversioned file in the source repository's git folder.

Gaps after P2: no model or mode picker on the page; no `agent_worktree_optimize` (dependency links, sparse checkout, so a fresh checkout has no `node_modules`); no "work on a copy" for a folder that is not a repository; discard ends the session rather than offering a new checkout; a worktree made by the desktop is listed (`agent_worktree_list`) but only a runner session's own can be acted on; the CLI's `[agent].worktree` setting and `~/.jan/worktrees` are not used by the server (the server's own root is).

### Parity gaps after P1 (said by `parityGaps`, not hidden)

- Plan-review UX, goal evaluation, TS-side compaction (the Rust loop compacts by its own policy), agent teams, the browser and computer panes.
- Attachments are not sent to a server session; "resume" (regenerate) is refused.
- Campaign tasks and verification on the server: P3. (Worktrees and proposals for server sessions: P2, below.)
- The transcript's `notMapped` list still applies to a reopened session (reasoning, tool images, plan snapshots, per-turn usage).
- Model and mode changes are server commands but have no picker on the page yet (P2 did not add one).
- Server sessions are listed beside local ones; deleting one from the Cowork list removes only the local row (the server's list restores it); `agent_run_delete` is the way, and the card has no button for it yet.
- Image tool results, content-part inputs above the 1 MB JSON body limit, and a client that dozes for longer than the 4096-event ring are covered by refetching the transcript, not by replay.

### Not verified

- No device or emulator was available: opening an external HTTPS origin inside the Tauri Android WebView, the cookie persisting across app restarts, and the back button returning to the bundled app were not exercised. Unit tests cover the address handling, the stored shape, the reachability probe and the countdown.
- The Android build itself (`yarn build:android`) was not run.
- The runner is covered by `tests/web_agent_run.rs`, which drives the real `flint serve` binary against a stub model: sign-in gate, confinement, the session cap, a turn, `after=` resume, a prompt denied and allowed, the approval timeout, an interrupt, a restart and resume. The sandbox was off in those tests (`--agent-require-sandbox=false`): enforcement of bash by the Windows AppContainer backend was not exercised here, and the `bwrap` and seatbelt backends not at all. The desktop feature set was not compiled for this change.
- The page side is covered by vitest with a mocked fetch and a hand-written event stream. It was not exercised in a real browser, the Android WebView, or over a flaky mobile network, so the reconnect timing (45 seconds of silence before a reconnect) is a design choice, not a measurement.
- A real provider and a real tool-heavy turn were not run through the server runner.
- Cowork and Campaigns pages on a phone-sized viewport were not reworked. The mobile shell (`src/mobile`) is the touch UI; the desktop pages are not made usable at 390 px by this change.
