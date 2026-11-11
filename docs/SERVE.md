# Running `flint serve`

`flint serve` runs Flint without a desktop window: a browser (or the Android build, see `docs/MOBILE.md`) signs in to it and uses chat, models, MCP servers, Cowork sessions and Discussion Rooms on that machine. This page covers starting it safely. Agent review and run planes are in `docs/MOBILE.md` and `docs/CAMPAIGNS.md`.

## Start

```
flint serve --listen 127.0.0.1:1340 --public-host flint.example.net
```

The first start prints an administrator credential once: 256 random bits. Only its SHA-256 hash is stored, in `<data folder>/web-server/auth.json`. With `--background` the server detaches, logs to `<data folder>/web-server/server.log` and leaves the credential for the starter to show; stop it with `flint stop` (same `--data-dir`).

Signing in with the credential gives a browser session that lasts 12 hours (HttpOnly cookie, `flint_session`). At most 32 sessions are live; signing in past that drops the oldest. Failed sign-ins are rate limited per client and overall.

## Lost or leaked credential

Stop the server, then run `flint serve --rotate-credential` (add the same `--data-dir`). It replaces the credential, ends every browser session, prints the new one and exits. It refuses while the server is running.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--listen`, `--bind` | `127.0.0.1:1340` | Address to bind. Keep it on loopback and put an HTTPS proxy in front. |
| `--public-host` | none | Exact DNS name the proxy serves. |
| `--allowed-host` | none | Exact `host[:port]` clients use. Required when `--listen` is not loopback. Repeatable. |
| `--allowed-origin` | none | Exact origin allowed to call the API cross-origin with a bearer token (a native app shell). Never a wildcard. Repeatable. |
| `--trust-proxy` | off | Believe `X-Forwarded-For` from a proxy on the same machine for sign-in rate limiting. Without it the header is ignored. |
| `--data-dir` | the usual Flint data folder | Shared data folder. |
| `--assets-dir` | the bundled web app | Folder holding the web bundle. |
| `--allow-mcp-stdio` | off | Let browser sessions add and start stdio MCP servers. These run programs on this machine. http and sse servers are always allowed. |
| `--llama-worker` | `FLINT_LLAMA_WORKER_BIN`, then beside the executable | The binary that runs local models. |
| `--agent-root` | none | A folder the agent review plane may use. Repeatable. May not contain the data folder. |
| `--agent-run` | off | Let signed-in clients run agent sessions. Needs `--agent-root` and an enforcing command sandbox. |
| `--agent-max-sessions` | 4 | Live sessions at once. |
| `--agent-allow-bypass` | off | Allow unattended modes (auto, bypass). |
| `--agent-allow-always` | off | Allow standing approvals from clients. |
| `--agent-allow-checks` | off | Let the server run a project's own commands for verification. |
| `--agent-approval-timeout` | 1800 | Seconds an unanswered approval waits before denial. |
| `--agent-require-sandbox` | true | Refuse sessions when commands cannot be sandboxed. |
| `--background`, `--detach` | off | Detach from the terminal. |

## Behind a reverse proxy

Never expose the plain HTTP port to a network. Terminate TLS on the same machine and forward to the loopback address.

Tailscale Serve:

```
flint serve --listen 127.0.0.1:1340 --public-host flint.<tailnet>.ts.net --trust-proxy
tailscale serve --bg https / http://127.0.0.1:1340
```

Caddy:

```
flint.example.net {
    reverse_proxy 127.0.0.1:1340
}
```

Start the server with `--public-host flint.example.net --trust-proxy`. Android's WebView cannot get past an untrusted certificate, so use a real one.

## What a signed-in client can reach

Everything behind the session gate: the same command surface the desktop web app uses (chat, models, providers, MCP servers, threads, Cowork and rooms), and, only with the `--agent-*` flags above, the review and run planes. Phone pairing (`/m/`, `/remote/*`) is not served and answers 404. Treat the administrator credential like a shell login on that machine, especially with `--allow-mcp-stdio` or `--agent-run`.

Public routes: the webhook route and the guest-link routes below, `GET /healthz` (answers `ok`, used by `flint stop`), the sign-in page and its session and token endpoints, and a shutdown route that only `flint stop` can use.

## Webhooks for scheduled tasks

A scheduled task set to **On webhook** (Settings > Schedules) starts when a service calls `POST`, `PUT` or `PATCH` `/hooks/<task id>/<token>` on this server. Copy the path from the task's editor and put the server's public address in front of it, for example `https://flint.example.net/hooks/task-1a2b3c4d5e6f/<token>`. The caller must be able to reach the server, and its host name must be one the server accepts (`--public-host` or `--allowed-host`).

This is one of the routes (besides the sign-in, health and guest-link routes) that answer without a session: its guard is the token in the URL, an optional HMAC-SHA256 signature over the raw body, a 1 MiB body cap and a limiter on failed attempts. Turn the signature on for anything reachable from the internet; without it anyone who learns the URL can start a run. For GitHub use content type `application/json`, the same secret in the repository's webhook settings, and keep the defaults (`x-hub-signature-256`, hex, `sha256=`).

Answers: `202` with the run id when a run started; `200` with `{"ignored":true}` when a filter did not match or the delivery id was already served; `401` for a bad signature; `403` when the task is switched off; `404` for an unknown task or a wrong token (the same answer, so ids cannot be probed); `409` when the previous run is still going; `413` for a body over 1 MiB; `429` when too many requests arrive. The `Rotate` button in the editor replaces the token and the old URL stops working at once. The request text reaches the agent as fenced, untrusted data; read `docs/FEATURES.md` (Scheduled tasks) for what that does and does not protect against.

## Guest links

A thread's menu has **Share with guest**: one thread, one person, no account. The guest opens `/g/<token>`, follows the thread live and can write messages. Those wait in the thread (a banner with **Send** and **Dismiss**); nothing is sent to the model or run until you press Send.

This works only while `flint serve` is running and the guest can reach it: the link is a path on this server, so the guest's browser must be able to open the server's address (use `--public-host`, or `--allowed-host` for the name you hand out). If the server is down, off the network or the name is not accepted, the link does nothing. A desktop app that is not itself serving shows the path only; put the server's address in front of it.

It is off until you turn on **Settings > Chat > Guest links**, because a link shows a thread outside your machine. While it is off every guest route answers 404. Turning it off ends every link.

What the link allows:

- The token appears once, in the URL you copy; only its SHA-256 is stored (`web-server/guest-shares.json` in the data folder). A new link for the same thread, Stop sharing, deleting or archiving the thread, and expiry (24 hours by default, adjustable to 7 days) end the old link at once, and its waiting messages are discarded.
- The first browser to open it is bound to it with an `HttpOnly`, `SameSite=Strict` cookie; any other browser gets 404. Link-preview bots do not bind it (the page binds on a script call). The page itself needs only the token, since a link opened from another app is a cross-site navigation that `Strict` strips cookies from; every read and write needs the cookie.
- Routes (`Public`, each with its own guard, 404 for anything unknown, expired, stopped or from the wrong browser): `GET /g/<token>`, `POST /g/<token>/join`, `GET /g/<token>/snapshot`, `GET /g/<token>/events` (server-sent events), `POST /g/<token>/message`. Posts need this server's own `Origin`; there is no CORS. Failures are rate limited per client, a message body is capped near 3 MiB, text at 4000 characters, at most 2 attachments of 1 MiB (images, text, PDF, JSON, CSV), 20 waiting messages and one message every 2 seconds.
- The page is one static file under a policy that loads nothing from anywhere (`default-src 'none'`, its script and style allowed by hash).
- The guest sees the text of user and assistant messages only. Tool calls and their inputs and outputs, file paths, memory, the system prompt, hidden messages and images are never sent; reasoning is shown only if you ticked it for that link. The live stream tells the page "this thread changed" and then sends the same filtered view, never an event's own payload. Updates arrive when a message is saved, not token by token.
- A guest message is untrusted. When you press Send it goes into the thread as a user turn wrapped and fenced as coming from a guest, with `$`, `@` and a leading `/` or `!` made inert so it cannot trigger a skill, file or command. Attachments are saved on the server and named in the message by path; they are not attached to the model request.
- The desktop app and `flint serve` share the share file, so a message queued while you use the desktop app appears within a few seconds.

## Data folder

Server state lives in `<data folder>/web-server/`: `auth.json` (credential and session hashes), `server.json` (where the running server listens), `server.log` (background mode) and `settings.json` (providers added from a browser; keys stay in the server's keyring).

## Run it as a service

systemd (user unit):

```
[Service]
ExecStart=/usr/local/bin/flint serve --listen 127.0.0.1:1340 --public-host flint.example.net --trust-proxy
Restart=on-failure
```

Run it in the foreground there (no `--background`). Read the first-run credential from `journalctl --user -u <unit>`, or run `flint serve --rotate-credential` once while the unit is stopped. Container use works the same way: mount the data folder, publish the loopback port to the proxy only.
