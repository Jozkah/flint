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
| `agent_campaign_transition` | Pause, resume (from paused only) and cancel a campaign. Task moves, plan approval and an integration worktree from a client are refused |
| `agent_campaign_cancel` | Cancel |
| `agent_proposal_list`, `_apply`, `_reject` | The stored, hash-approved proposal path. The destination is the stored proposal's project, which must be under a root |

Every path is canonicalized and must sit inside a root. Nothing here spawns a process, runs a build or test, merges, discards a worktree or executes a tool. Every call needs the bearer token or session cookie like any other server call; the same-origin and host checks apply.

### What blocks agent runs on a headless server

1. **No tool executor in the headless build.** `execute_tool`, the write grants and the sandbox status live in `tauri-plugin-agent-tools` behind its `tauri` feature, which the `flint` binary leaves out on purpose (no GUI stack in the graph). The browser transport has no way to call them, and `Channel` streaming is not available in `tauriBridgeShim`.
2. **The Cowork loop and the campaign scheduler are renderer code** (`coworkRunner.ts`, `campaignRunner.ts`, `campaignHost.ts`). `useMailboxDelivery` returns early when there is no Tauri bridge, so the campaign host is not even started in the browser build. Moving the loop to the apk's WebView would run the model calls on the phone and leave the tools on a server that cannot run them.
3. **Roughly eighty `agent_*` and `plugin:agent-tools|*` commands** back a Cowork session and the board (worktrees, mailbox, checkpoints, skills, memory, access). The server answers none of them except the review plane above.

The way through, and the real work, is a server-side runner. The Rust loop (`core::agent::loop`, `core::cli::rpc` sessions) already runs turns headless, `campaign_scheduler::next_actions` is a pure function, and P7 in `docs/CAMPAIGNS.md` names the durable worker. It needs HTTP endpoints for start, steer, stop, approvals and an event stream, and a UI mode in which Cowork drives that instead of the renderer loop.

### Not verified

- No device or emulator was available: opening an external HTTPS origin inside the Tauri Android WebView, the cookie persisting across app restarts, and the back button returning to the bundled app were not exercised. Unit tests cover the address handling, the stored shape, the reachability probe and the countdown.
- The Android build itself (`yarn build:android`) was not run.
- `cargo test` was not run for the new server module; `cargo check --tests` passes for the `cli` feature. The desktop feature set was not compiled; the module uses only code that is compiled in both.
- Cowork and Campaigns pages on a phone-sized viewport were not reworked. The mobile shell (`src/mobile`) is the touch UI; the desktop pages are not made usable at 390 px by this change.
