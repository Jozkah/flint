# Agent messaging

Cowork sessions can talk to each other. The user tells the agent in one session
to ask another session something, and the agent does it mid-prompt. Rooms are a
separate feature and are not covered here.

Source of truth: `src-tauri/plugins/tauri-plugin-agent-tools/src/session_mailbox.rs`
(and `session_mailbox/stop.rs`). Web side: `web-app/src/lib/sessionMailbox.ts`,
`mailboxPresence.ts`, `mailboxDelivery.ts`, `mailAutoReply.ts`.

## Threat model

- A message is data, not authority. It is never the user's voice, never an
  instruction the receiver must follow, and cannot grant or approve anything.
  Every tool result that carries a message is marked `untrusted` and repeats
  that notice.
- Same user, same app. Sessions are registered by the running Flint process
  under its own data folder. There is no network path and no other user.
- The target's permissions are unchanged. A message cannot widen what the
  receiving session may do. Tools the receiver runs because of a message go
  through that session's normal approval prompts, shown in that session.
- `stop_session` is the only tool that acts on another session. Every call is
  put to the user ("Allow once" only, no standing grant).
- Session titles and folders are written by other sessions and are untrusted.
- Messages are rendered as plain text in a visible card; they are never
  interpreted as markup that could hide their origin.

## Identity and presence

The web app registers every Cowork session in `<data>/mailbox/sessions.json`
(title, folder, accepts-messages flag) and reports run status. Registration is
sequenced before a run's first status call, so a session that starts working
right after it was created is never refused with `session not registered`.
A `running` record without a heartbeat for 90 s, or from another process epoch,
reads as `unavailable`.

## Limits

| Limit | Value |
| --- | --- |
| Message length | 8000 characters |
| Rate per sender | 10 per 60 s |
| Rate per sender to one target | 30 per hour |
| Reply chain depth | 6 (replies increment, a new thread is depth 0) |
| Wait for a reply | 1 to 120 s |
| Retention | 7 days |

Refusals are typed (`rate_limited`, `pair_limit_exceeded`,
`reply_depth_exceeded`, `self_target`, `recipient_opted_out`, ...). A session
cannot message itself. A loop A -> B -> A made of replies stops at the depth
cap; a loop made of fresh sends stops at the rate limits.

## Opt-out

Each session has an "accepts messages" switch (default on). A session that
turned it off is still listed, but sends to it are refused with
`recipient_opted_out`.

## Tools (Cowork sessions only)

- `list_sessions` -- other sessions: id, title, folder, status, accepts
  messages, last activity.
- `send_message({to, message, wait_seconds?})` -- `to` is a title or id. Fire
  and forget by default; with `wait_seconds` it waits for the answer and returns
  it as the tool result.
- `read_messages`, `wait_for_reply` -- read the inbox / wait for a reply.
- `stop_session` -- see the threat model.

Chat threads and subagents do not get these tools.

## Delivery

- Idle target: the message wakes the session and is handled in a new turn,
  shown as a "from <title>" card in the target thread. The user can see it and
  stop it like any run.
- Running target: delivered at the next step boundary of the run.
- A run that handled a message and ended without replying has its final answer
  sent back as the reply.
