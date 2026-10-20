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
(title, folder, inbound mode) and reports run status. Registration is
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

| Chain length | 4 hops (`[messaging] max_hops`) |
| Wake-ups one chain causes in one session | 3 |
| Wake-ups by relayed mail per session | 6 per 60 s |

Refusals are typed (`rate_limited`, `pair_limit_exceeded`,
`reply_depth_exceeded`, `chain_limit_reached`, `self_target`,
`recipient_opted_out`, `session_archived`, ...). A session cannot message
itself, by id or by its own title.

### Chains (loop guard)

Every envelope carries a `chainId`, a `hops` count and the `chainPath` of
sessions that sent along it. The backend stamps them; no tool argument can set
or reset them:

- A message the user sends (the Reply form), or one an agent sends in a run
  the user started, starts a chain: `hops` 0, `chainId` its own id.
- When mail is handed to a session (`mailbox_claim`, `mailbox_take_for_delivery`)
  the session's registry record arms that chain; the next run start takes it
  (a run nothing handed mail to starts clean). A message sent by that run
  continues the chain at `hops + 1`; an automatic reply continues the message
  it answers.
- A send whose `hops` would reach `max_hops` (default 4) is refused with
  `chain_limit_reached`, telling the agent to ask the user. So a ring of N
  sessions told to forward a message wakes at most `max_hops` sessions.
- Mail that would revisit a session already in the chain twice
  (`chain_cycle`), the 4th wake-up of one session by one chain through the same sender
  (or the 17th by one chain in all)
  (`chain_wakes`), or the 13th wake-up of one session by relayed mail within a
  minute (`wake_rate`) is delivered with a `hold` reason: it never auto-wakes
  its recipient, which shows it as "Chain limit reached, waiting for you".

`max_hops` is read from the sender's project `.jan/agent/agent.toml`:

```toml
[messaging]
max_hops = 3   # 1..=16; an untrusted folder may only lower the default
```

Chain fields are persisted with the mail and the registry, so they survive a
restart.

## Inbound control

Each session has an `inbound` mode, shown by `list_sessions`:

- `accept` (default): delivered as usual.
- `refuse`: still listed, but sends to it are refused with `recipient_opted_out`.
  This is the old "Accept messages from other sessions" switch turned off; a
  session written before the mode existed maps on to accept, off to refuse.
- `hold`: the "Ask me before delivering" switch (Details tab, only while
  messages are accepted). The message is stored undelivered and shown in that
  session with Approve (delivered once, like any queued mail) and Deny
  (dropped). Nothing wakes the session and no model sees it until Approve. The
  sender's receipt says `inbound: held`; a held reply does not satisfy
  `wait_for_reply`.

Held mail has a 5-minute deadline (`HELD_TTL_MS`): unanswered, it is dropped
and the sender gets a notice that it expired. At most 100 wait per session; the
oldest is dropped (and its sender told) when a 101st arrives. Expiry is checked
whenever the mailbox is read, so a deadline passes even for a session nobody is
looking at. A dropped notice does not produce a notice of its own.

Approving only releases untrusted text. A message can never approve a
permission prompt or change a setting, held or not.

## Notify when idle

`send_message({to, notify_when_idle: true})`, with or without a message, asks
for one short notice when `to` next finishes a turn with nothing queued for it,
or is deleted. With no message nothing is sent to that session; if it is already
idle with nothing queued, no subscription is made and the result says so.

- The notice is an ordinary mailbox message from the watched session
  (`origin: notice`, one line). It passes the same limits, loop guard and inbound
  control as any message: it continues the chain the asker had when it
  subscribed, so subscribe-and-wake loops stop at `max_hops`, and an asker that
  holds mail sees it as a held message. A notice is never answered
  automatically.
- A subscription lapses after 12 hours and the asker is told. One per asker and
  target (asking again restarts it), at most 20 per asker. Stored in
  `mailbox/subscriptions.json`.
- Only a main Cowork session can subscribe: subagents have no messaging tools.
- A turn that ends while mail is still queued for the session does not fire; the
  next turn that finishes with nothing queued does. The host cannot see input
  the user typed into a session's own queue.

## Tools (Cowork sessions only)

- `list_sessions({include_archived?})` -- other sessions: id, title, folder,
  status, accepts messages, last activity; `you` names the calling session.
  Archived sessions are left out unless asked for.
- `send_message({to, message?, wait_seconds?, reply_to?, notify_when_idle?})` --
  `to` is a title or id. Fire and forget by default; with `wait_seconds` it waits
  for the answer and returns it as the tool result. `message` may be left out only
  with `notify_when_idle: true` (see above).
- `read_messages`, `wait_for_reply` -- read the inbox / wait for a reply.
- `stop_session` -- see the threat model.

Chat threads and subagents do not get these tools.

## Delivery

- Idle target: the message wakes the session and is handled in a new turn,
  shown as a "from <title>" card in the target thread. The user can see it and
  stop it like any run.
- Running target: delivered at the next step boundary of the run.
- Archived target: refused with `session_archived` until the session is
  restored (the app reports archive with `mailbox_session_archive`; a restore
  registers it again).
- A run that handled a message and ended without replying has its final answer
  sent back as the reply.

## Sharing a folder

Sessions attached to the same folder see each other (one line in the environment
block). A `write`/`edit` of a file another live session is editing, and a
tree-changing git command while another session shares the tree, come back as a
plain "Not written." / "Not run." result naming that session. Use `send_message`
(a one-line "Editing <path> for <reason>" is the convention), re-read, then retry:
one retry after a message or re-read goes through. Holds are advisory and never
permanent. Design: `docs/superpowers/specs/2026-10-19-shared-folder-coordination-design.md`.

## Subagents

A finished subagent can be continued instead of replaced. Its `task` result ends
with an `agent_id` line; calling `task` again with `resume_agent_id` and the
follow-up as `description` runs the same agent on its retained conversation
(same definition, same id). Rules:

- Kept in memory per session (24 most recent), so it ends with the app or when
  the session is deleted. An unknown id is refused with an explanation.
- Not kept for a run stopped by the user, a failed run, or a member of a `team`.
- A subagent still never gets the session-messaging tools or `ask`.

### Subagent questions

A background subagent (not a foreground one, whose parent is blocked in the call)
gets an `ask_parent({question})` tool. The question shows as a card in the
parent's thread and reaches the parent's agent as a notice at its next step
boundary; the parent answers with `answer_subagent({question_id, answer})` and
the answer returns to the child as the tool result.

- Bounded: the child waits at most 120 s (then continues on its own
  assumption), questions are capped at 2000 characters and answers at 4000,
  a child may ask 3 questions in total and a session may have 6 open at once.
- An answer is information. It is fenced as such and cannot grant a permission;
  the child's own approvals are unchanged. Stopping the child or deleting the
  session cancels the wait.
- Questions and notices live in memory and end with the app.

### Completion notices

Nothing needs polling:

- A background subagent that finishes or fails leaves a one-line notice
  (name, task_id, short preview) that reaches the parent agent at its next step
  boundary, as a fenced "Flint notice" message that is information only. The
  full answer is still read with `await_task`. A stop the user asked for is not
  announced. Notices for a deleted session are dropped.
- A session that answers an earlier fire-and-forget `send_message` (or asks
  something back) arrives as a mailbox message: at the next step boundary when
  the sender is running, or by waking it when it is idle, with the usual
  "from <title>" card. A run that handled a message and ended without replying
  has its final answer sent back automatically.

## Not supported

Messaging is local to this machine. Sessions reach each other through the app's
own in-process mailbox, so a session cannot message one on another computer, on
a phone paired to this app, or in another user's Flint, and there is no setting
to allow it (Claude Code's "isolate peer machines" switch has nothing to
switch here). Reaching across machines would need a relay both sides trust:
somewhere to authenticate each peer, route and queue messages while one is
offline, and decide what a remote message may do. Flint runs no such service,
and a message is untrusted text that must never become authority, which a relay
would make much harder to keep true. Until there is one, run the sessions that
need to talk on the same machine.
