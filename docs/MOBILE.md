# Mobile: the phone app and the Android build

Two different things are called "mobile" in this repo. Keep them apart.

## The phone app ("remote")

`web-app/mobile.html` + `web-app/src/mobile/**` is a separate Vite entry (`vite.mobile.config.ts`, `yarn build:mobile`, output `src-tauri/resources/mobile`). The desktop app's remote-access server (`src-tauri/src/core/remote`) serves it at `https://<computer>:1340/m/`. `flint serve` does not: phone calls are run by the desktop window's TypeScript, which a headless server has none of, so `core::remote` is not built into the `flint` binary and the headless package (`yarn build:server`) carries no phone bundle. On `flint serve`, `/m/` and `/remote/*` answer 404 with a page saying phone pairing needs the desktop app, and `remote_*` commands answer the same in words; a phone uses such a server by opening its address in the browser (or the .apk, below). A paired phone installs it as a PWA (`mobile-public/manifest.webmanifest`, push through a service worker in `src/mobile/sw`) and reaches the computer directly, over Tailscale or any route to that port.

How it works:

- Pairing: a code on the computer, confirmed there, gives the phone a bearer token (`api/client.ts`, `state/pairing.ts`).
- Calls: `POST /remote/v1/rpc {id, method, params}`. The Rust server checks the token and the approvals switch, then emits `remote://rpc` to the desktop window, which runs the method in TypeScript (`lib/remote/bridge.ts`, `handlers.ts`, `app*.ts`) against the same stores and Tauri commands the desktop UI uses, and answers through `remote_rpc_respond`. There is no method allow-list in Rust: the handler map in TypeScript is the allow-list (an unknown name answers `unknown_method`). The Rust side only gates names that start with `approvals.` on "Approvals from phones" (and `scope: "always"` on "Always allow from phones") in `hub.rs::check_policy`.
- Events: a WebSocket (`/events`) carries approvals, run state and reply streams; Web Push covers a hidden page.
- So the agent loop, safety checks, redaction and worktrees run on the computer, in the same Rust loop for a phone's session as for a desktop one. Anything a phone does is a desktop action with the phone as the remote control.

- Certificate: on a home network without Tailscale or a user-supplied pair, the server makes a self-signed certificate (`remote/tls.rs::self_signed`) and keeps it until the address or custom host name changes. It is deliberately never rotated on a timer: a phone trusts it once (its fingerprint is shown in Settings > Remote access), and a silent rotation would break every paired phone with a certificate error and invite users to click through warnings. rcgen's default validity is effectively unlimited, so it does not expire either. To rotate it by hand (for example after the key may have leaked), turn remote access off, delete `lan-cert.pem`, `lan-key.pem` and `lan-cert.ip` from the `tls` folder of the remote-access state folder, turn it back on, and trust the new fingerprint on each phone. Tailscale certificates are renewed automatically after 30 days.

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
| Chat / Cowork sidebar tabs, Resume and usage, folded More | PORTED: the drawer has a Chat / Cowork switch under search (remembered, follows the route), Resume & usage, Models and Discover on both tabs, a campaign group with one dot per row and "N of M done", and one folded More (Archive, System Monitor, Local API) on Cowork (`shell/LeftNav.tsx`, `shell/navTabs.ts`) | N/A |
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

   Add `--trust-proxy` when a proxy on the same machine fronts the server, so sign-in rate limiting keys on the client its `X-Forwarded-For` names; without it that header is ignored and the peer address is the key. `--agent-root <folder>` is optional and repeatable. It turns on the review plane described below for projects under that folder. A root may not contain the data folder (the server refuses to start if it does).
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
| P2 | Worktrees and proposals for server sessions: an isolated, server-owned checkout per writing session, `agent_worktree_*` commands by session id, a proposal after each turn that changed something, the worktree panel on the page | Landed (model, mode, rename and delete controls came later: see "Closing the gaps") |
| P3 | Campaign driver on the server: plan, approve, tasks on worktrees, verify, merge, resolver, limits, restart continuation; plan approval and finalize stay a person's | Landed (see "What P3 does") |

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
| `agent_run_create` | `folder` (inside a root), `access` (`read`, `ask`; `auto`/`bypass` need the flag), `mode` (a label, default `cowork`), `model`, `title`, `role` (`coordinator`, see below) | `{ id, folder, model, access, status }` |
| `agent_run_start` | `id`, `input` (text or content parts, within the stdio protocol's caps), `attachments` (optional, see "Closing the gaps") | `{ turnId, after }`. One active turn per session (409); 20 turns a minute (429). A stored session that is not live is resumed first. |
| `agent_run_steer` | `id`, `text` | Delivered at the loop's next safe point. |
| `agent_run_interrupt` | `id` | Aborts the turn, denies pending prompts, persists what the turn had, emits `done{stop_reason: "cancelled"}` then `turn.completed{stopReason: "interrupted"}`. |
| `agent_run_approve` | `id`, `requestId`, `decision` (`allow_once`, `deny`, `allow_always` if enabled) | The request id must belong to that session and still be pending (404 otherwise). Audited in the session's event log (`permission.decided`: request, tool, decision, a digest of the client and of its address). |
| `agent_run_answer_ask` | `id`, `requestId`, `results` | Validated against the question before it is delivered. |
| `agent_run_set_model`, `agent_run_set_mode` | `id`, `model` / `access` | Refused while a turn is active (409). A model the server cannot reach is 422; `auto`/`bypass` need `--agent-allow-bypass` (403). A stored session that is not live is changed in its record and takes the change when it resumes. |
| `agent_run_models` | none | `{ models: [{ id, provider, label, contextWindow, contextSource, supportsTools }], default }` from the providers configured on the server. Ids, names and sizes only: never a key, header or endpoint. `supportsTools` is `null`: the server does not know a model's tool support. |
| `agent_run_rename` | `id`, `title` | `{ title }`; at most 80 characters, no control characters. |
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
- A remote session gets the built-in tools only: no MCP server is connected for it and no host tool is declared, except that a session created with `role: "coordinator"` is declared the campaign tools, which this process answers itself (see "Closing the gaps"). (P2: a session that may write works in its own worktree; see below.)

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

Operator switch: `--agent-allow-checks` (default off) is reported as `runsChecks`. P2 itself runs no project command; P3 gates the verification checks and the final gate on it. `runsWorktrees` in `agent_server_info` says the capability is built, `runsCampaigns` that the campaign driver is.

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

### What P3 does: campaigns run by the server

A campaign whose `driver` is `server` (a new additive field on the record; every record that predates it, and every campaign the desktop makes, is `renderer`) is run by the server with no client attached. One tokio task owned by the server (`web_server/campaign_driver.rs`) reads the campaign records every 3 seconds and whenever one of its jobs settles, and does what the record calls for. The decisions are the existing backend ones (`campaign_scheduler::next_actions`, `campaign_integration::*`, the verification rules); the driver only supplies the effects, behind a `Host` trait so the logic is tested with a fake.

| Step | What the server does |
| --- | --- |
| Start | `next_actions` with the live sessions and tokens as `LiveState`; parallelism is `min(campaign limit, --agent-max-sessions)` and free session slots. A task gets a runner session on its own worktree (under the server's folder, branched from the integration branch) in the campaign's mode (`ask`, or `auto` only with `--agent-allow-bypass`; never `bypass`), seeded with the fenced brief, acceptance, decisions (8 000 characters) and upstream handoffs (24 000), a port of `campaignSeed.ts`. |
| Watch | A prompt or a question mirrors to `awaiting_approval` or `awaiting_input` and pings `agent-approval-pending`. Per-task wall clock, steps and tokens stop the run and fail the task with the reason. A prompt is denied by the runner at `--agent-approval-timeout`; a question that nobody answers within twice that stops the task. |
| Settle | On a turn end: commit pending work on the declared paths, write the handoff (final message, commits), `task_settle`, free the session slot. |
| Verify | `verify_prepare` (the backend builds the evidence), one tool-free model call through the server's own provider path (300 s deadline), `verify_finish` (the objective check, the downgrade rules, one repair round). Without `--agent-allow-checks` the objective check is not run and the verifier decides from the diff alone. |
| Merge | `integrate`: verified tasks in topological order into the integration branch. A conflict gets one resolver session (`resolve_prepare`), verified and merged like a task; a second conflict waits for a person. A merge pass that moves nothing backs off for 30 seconds. |
| Review | When every task is merged the campaign is `reviewing` and **stops**. Finalize is a person's call. |
| Restart | The first read after a restart reconciles the record (`interrupted`); the driver moves the campaign back to `running` and queues the interrupted tasks, which resume in the session and worktree they already have (or start again from their brief when the session is gone). A task whose session keeps vanishing fails after 3 tries. |
| Cancel, pause | Cancel interrupts and closes every live session of the campaign; pause lets running work settle and starts nothing. A terminal campaign owns no live session. |

Human gates (nothing is auto-approved, ever):

| Command | Arguments | Result |
| --- | --- | --- |
| `agent_campaign_start_server` | `goal`, `folder` (a git repository inside a root), `options` (`model`, `maxParallel`, `tokenBudget`, `taskTokens`, `taskSteps`, `wallClockSecs`, `title`, `plan`) | the campaign, `planned`, `driver: "server"`. Nothing runs and no worktree exists yet. |
| `agent_campaign_approve` | `id`, `access` (`worktree` or `ask`) | Makes the integration branch and worktree (keyed by the campaign, under the server's folder), records the choice, and starts. `worktree` lets tasks work in auto mode inside their own folder and needs `--agent-allow-bypass` (403 otherwise). Rejecting is `agent_campaign_cancel`. |
| `agent_campaign_finalize` | `id`, `seconds` | Runs the gate and stores ONE proposal against the user's checkout; applying it is the existing proposal plane. A gate command that would run needs `--agent-allow-checks` (403 otherwise); with no gate command it is skipped with the visible warning. |
| `agent_campaign_cancel` | `id`, `detail` | As before, and aborts the campaign's live runs. |
| `agent_campaign_approvals` | none | What waits on a person: `plan`, `finalize`, and `task` (a prompt or question). The same states show in the campaign record (`planned`, `reviewing`, a task `awaiting_*`) and as `agent-approval-pending` pings on `/api/v1/events`. A task's own prompt is answered with `agent_run_approve` / `agent_run_answer_ask` on its session, exactly as in P1. |

Also reachable now, with the same confinement (and only with `--agent-run`, because they run `git`): `agent_campaign_plan_update` (a campaign of this server, planned or draft only, the whole plan re-validated), `_diff`, `_task_diff`, `_gate_plan`, `_refresh`, `_orphans`, `_claim_notice`. The raw task move (`agent_campaign_transition` with a task), settling, verification and merging stay refused for a client: they are the driver's. A person's moves on a task (retry, skip, accept anyway, verify again, resolve, gate repair and retry) are separate, audited driver commands, below.

**How the plan is made.** By default a one-shot planner: a model call through the server's provider with a strict JSON schema, held to `validate_plan` with one repair round, whose goal and file list are fenced as untrusted data; the plan is stored `planned` for a person to approve (or edit with `agent_campaign_plan_update`). A caller may pass its own `plan`, which skips the model. With `coordinator: true` the server instead starts a coordinator conversation (below) and falls back to the planner when it cannot.

On the page: `campaignApi` already runs over the server transport (the `invoke` stand-in posts to `/api/v1/rpc/<command>`), so the board, the Campaigns page and the review panel work unchanged against a server. Added: `runsCampaigns` in the probe, `campaignApi.startServer|approve|approvals`, "Plan campaign on server" in the Server agents card (a git folder, a goal), and on the board a plan approval card for a planned server campaign (the access choice, Approve and start, Reject). The renderer's campaign host, runner `kick`, `sweep`, `resume` and `verifyTask` do nothing for a campaign whose `driver` is `server`.

Security notes (P3):

- The driver acts only on records whose `driver` is `server` and whose `sourceRoot` still resolves inside an `--agent-root`; a record copied in from elsewhere is never driven. Worktrees are re-derived from Git before every commit, verify, merge and resolve (`trusted_worktree`), so a forged path or branch in a record is refused there.
- Task modes: never above the campaign's recorded ceiling, never `bypass`, and `auto` only with `--agent-allow-bypass`. A task that wants something outside its folder, the network or a destructive command still asks, and the ask waits for a signed-in person.
- Project commands (the per-task objective check, the gate) run only with `--agent-allow-checks`; with it, they run on the host with the user's shell and the deadlines of the desktop (180 s a check, 600 s the gate, at most 900 s). They are not inside the command sandbox that bash runs under.
- The planner and the verifier are model calls through the server's configured provider and credentials, in a folder of the server's own (`<data>/agent-workspace/utility`), never in the repository. Their input includes repository text (file names, diffs, handoffs) fenced as untrusted; a verdict still goes through the backend's rules, which can only take a PASS away.
- Per-task limits are enforced, and the project token budget stops new starts at 100 percent; running tasks are bounded by their own limits only (a campaign with no task limits and no wall clock can run up to the model's own session ceiling).
- Handoffs and decisions travel from agent to agent as fenced data (`<upstream-handoff>`, `<campaign-decisions>` with the tags defanged), as on the desktop.

Gaps after P3:

- (Closed, see "Closing the gaps".) A task move from a client used to be refused; a blocked verification had no server command to run it again.
- A resolver that fails once leaves the conflict parked; a person asks for another attempt with `agent_campaign_resolve` only until the record shows a resolver was started once, after that it is retry with a hint or skip.
- Reasoning, tool images, plan snapshots and per-turn usage are still not in the transcript of a task session (see "What the P0 transcript does not carry yet").
- The token count of a task is the provider's usage events summed over the session, and a verifier's is the provider's `usage` or an estimate from sizes.
- A campaign uses `options.model` or the server's default model; there is no per-task model.
- Campaign sessions run built-in tools only (no MCP), like every server session.
- `agent_campaign_next_actions`, `_decisions_append`, `_task_settle`, `_verify_*`, `_merge_task`, `_integrate`, `_create` and `_transition` with a task move or an approval are not reachable on a server, on purpose. (`agent_campaign_resolve` is answered, with a different meaning: see below.)

### Closing the gaps: task moves, pickers, coordinator, attachments

#### Task and gate moves from a client (S1)

`agent_server_info` lists the moves a client may ask of a campaign this server drives in `campaignCommands` (empty when the server drives none). Each one is executed by the driver (`Driver::task_command`, `gate_repair`), through the same state machine the renderer's moves go through (`campaign::transition_task`, `skip_task`, `accept_manually`), and each is refused with 403 when the campaign's `driver` is not `server`. The client never writes task state: `agent_campaign_transition` with a task still answers 403.

| Command | Arguments | What the driver does |
| --- | --- | --- |
| `agent_campaign_retry_task` | `id`, `taskId`, `hint` | A `failed` or `conflict` task goes back to `queued` (the retry cap applies); a hint is recorded fenced as the person's direction and leads the next seed. |
| `agent_campaign_skip_task` | `id`, `taskId`, `dependants` (`leave`, `cascade`, `release`) | Cancels the task and, as chosen, its dependants or releases them to run without it; the sessions of what was cancelled are interrupted and closed. A task that is verifying, verified, resolving or already finished is refused. |
| `agent_campaign_accept_task` | `id`, `taskId`, `reason` | Only a `completed` task whose verdict is `BLOCKED`, and only with a non-empty reason. Recorded as `manualOverride` with `by: "client <digest>"` and the reason; the driver then merges it like a verified task. |
| `agent_campaign_verify_again` | `id`, `taskId` | Starts the check again in the background (`{ started: true }`); the verdict is read from the record. Needs the campaign `running`. |
| `agent_campaign_resolve` | `id`, `taskId` | A `conflict` task with no resolver yet gets the driver's resolver started (one attempt per conflict). Not the desktop command of that name: no session id is taken. |
| `agent_campaign_gate_repair` | `id` | The one repair task a failed final gate asks for; the campaign goes back to `running`. |
| `agent_campaign_retry_gate` | `id`, `seconds` | The final gate again after a repair merged; the same `--agent-allow-checks` rule as finalize. |

Audit: every move appends `client-command` to the campaign's event log (`<what> by client <digest> from <address digest>`, never a token), and accept anyway also writes `task-accepted-manually`. `campaignApi` (`retryTask`, `acceptAnyway`, `verifyAgain`, `resolveTask`, `skipTask`, `repairGate`, `retryGate`) calls these by name on a server page and the desktop's transitions otherwise, and the board's actions (`createBoardActions`) route a server campaign's retry, skip, accept, verify again, resolve, note (to the session's `agent_run_steer`), stop (`agent_run_interrupt`) and cancel there. The objective check is still opt-in: a verification re-run runs the project's check command only when the server was started with `--agent-allow-checks` (see `docs/CAMPAIGNS.md`, "Objective checks"); without it the verifier decides from the diff alone and a thin diff stays BLOCKED, which "accept anyway" with a reason is for.

#### Pickers, rename, delete (S2)

The "Server agents" card lists each session with a model select (from `agent_run_models`), an access select limited by `allowBypass`, an inline rename (`agent_run_rename`) and a Delete button that asks first (`agent_run_delete`). Model and access are disabled while a turn is active. A session at rest is changed in its stored record and uses the change when it resumes; `agent_run_get` now returns its `access` and `role` for that.

#### Coordinator conversation (S3)

`agent_run_create` with `role: "coordinator"` (or `agent_campaign_start_server` with `coordinator: true`) makes a session that is declared nine campaign tools: `campaign_plan`, `campaign_status`, `campaign_collect`, `campaign_cancel`, `campaign_steer`, `campaign_decide`, `campaign_verify`, `campaign_merge`, `campaign_orphans` (the declarations are a port of `campaignToolSchemas.ts`, and a test pins the names). They are host tools whose host is the server process: the session's actor answers every `ToolRequest` itself against the campaign record and the driver (`web_server/coordinator.rs`), and the request is never published to a client. A non-coordinator session is never declared them, and a request from anything but the coordinator's own main run (a subagent) is refused.

- Scope: a coordinator sees and steers only campaigns whose `coordinatorSession` is itself and whose driver is the server; another session's campaign reads as absent. A read-only (`read`) session cannot be a coordinator and the tools refuse in plan mode.
- `campaign_plan` records a `planned` campaign (the server's limits, the session's model) and returns at once. **Plan approval stays a person's**: `agent_campaign_approve`, the same endpoint and the same `agent-approval-pending` ping. One open plan per session; a revision (`campaign_id`) replaces the tasks of a plan still `planned`.
- `campaign_merge finalize` never runs the gate: it reports `awaiting_user` and raises the finalize approval (`agent_campaign_finalize`). Merge, skip and resolve go through the driver.
- `campaign_steer` goes into the task session's running turn (`agent_run_steer`), fenced as coming from the coordinator. `campaign_verify` starts the checks in the background. `campaign_orphans` lists only.
- The coordinator is not woken when a task finishes (the desktop pushes notices into its mailbox): it reads `campaign_status` and `campaign_collect` when the person asks or on its next turn.
- Fallback: `coordinator: true` falls back to the one-shot planner (the answer is a campaign, with `coordinatorError`) when the session cannot start (the session cap, no model); a refusal (bad folder, outside the roots) is final. The answer on success is `{ coordinator: { id, ... }, campaign: null }`; the campaign appears when the coordinator calls `campaign_plan`.
- The card's "Plan in a conversation" option opens the coordinator in Cowork.

#### Attachments (S4)

`agent_run_start` takes `attachments: [{ name, mime, data }]` (base64, at most 8, the message at most the large JSON body of 64 MB, otherwise the stdio caps: 5 MB per image, 10 MB of images, 16 MB a line). Images become `image_url` content parts, the shape the CLI sends; text files (`text/*`, JSON, XML, YAML, TOML or a known source extension) of at most 512 KB each and 1 MB together are folded into the message as fenced text marked as data. Everything is checked before anything is written (415 for a type nobody reads, 400 for bad base64, 413 for size). The files are kept under `<data>/threads/<session>/attachments/<n>-<name>` (the session's own folder in the server's data folder, never under an agent root; names are reduced to `[A-Za-z0-9._-]`, so a path in a name goes nowhere). The Cowork composer sends staged documents as message text (the same inlining as a local run) and images as attachments; audio and video are refused with a message.

### Parity gaps after P1 (said by `parityGaps`, not hidden)

- Plan-review UX, goal evaluation, TS-side compaction (the Rust loop compacts by its own policy), agent teams, the browser and computer panes.
- Images and text documents are sent to a server session (see "Attachments"); audio and video are not. "Resume" (regenerate) is refused.
- Campaign tasks and verification on the server: P3, above, and "Closing the gaps" (coordinator conversation, task moves).
- The transcript's `notMapped` list still applies to a reopened session (reasoning, tool images, plan snapshots, per-turn usage).
- Model, access, rename and delete are controls of the "Server agents" card; the Cowork page's own model picker is the desktop's and does not change a server session.
- Server sessions are listed beside local ones; deleting one from the Cowork list removes only the local row (the server's list restores it); the Delete button on the card calls `agent_run_delete`.
- Image tool results, content-part inputs above the 1 MB JSON body limit, and a client that dozes for longer than the 4096-event ring are covered by refetching the transcript, not by replay.

### Not verified

- No device or emulator was available: opening an external HTTPS origin inside the Tauri Android WebView, the cookie persisting across app restarts, and the back button returning to the bundled app were not exercised. Unit tests cover the address handling, the stored shape, the reachability probe and the countdown.
- The Android build itself (`yarn build:android`) was not run.
- The runner is covered by `tests/web_agent_run.rs`, which drives the real `flint serve` binary against a stub model: sign-in gate, confinement, the session cap, a turn, `after=` resume, a prompt denied and allowed, the approval timeout, an interrupt, a restart and resume. The sandbox was off in those tests (`--agent-require-sandbox=false`): enforcement of bash by the Windows AppContainer backend was not exercised here, and the `bwrap` and seatbelt backends not at all. The desktop feature set was not compiled for this change.
- The page side is covered by vitest with a mocked fetch and a hand-written event stream. It was not exercised in a real browser, the Android WebView, or over a flaky mobile network, so the reconnect timing (45 seconds of silence before a reconnect) is a design choice, not a measurement.
- A real provider and a real tool-heavy turn were not run through the server runner.
- P3 is covered by driver unit tests with a fake host (dependency order, parallel and session caps, approvals stall, limits, pause, cancel, restart, a campaign outside the roots, a renderer campaign), and by `tests/web_agent_run.rs` against the stub model: a plan from the planner, the approval gate, three tasks with a dependency, verification, merge, finalize, a proposal applied, and a restart in the middle of a run. Not exercised: a real provider planning or verifying, a conflict resolver end to end (the fake and the backend's own fixture-repo tests cover its parts), `--agent-allow-checks` with a real build command, the Windows AppContainer or any other sandbox under a campaign task, and the board's approval card in a real browser or the Android WebView.
- The gap closures are covered by `tests/web_agent_run.rs` (task moves with the audit trail and the blocked-then-accepted and verify-again paths, the pickers on a live and a stored session, a coordinator that plans through an in-process tool and is the only session offered the tools, attachments stored in the session folder), by driver unit tests with the fake host, and by vitest for `campaignApi`, the board's server routing, the card's session row and the media conversion. Not exercised: a real provider calling the campaign tools, the coordinator across a server restart mid-plan, and the card in a real browser or the WebView.
- Cowork and Campaigns pages on a phone-sized viewport were not reworked. The mobile shell (`src/mobile`) is the touch UI; the desktop pages are not made usable at 390 px by this change.
