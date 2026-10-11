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
