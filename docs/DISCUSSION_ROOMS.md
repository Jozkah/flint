# Multi-model discussion rooms

Status: design contract for `feature/discussion-rooms` (based on
`feature/session-messaging`). Implementation notes and verification results
are appended as work lands. Shared types: `web-app/src/lib/rooms/types.ts`.

## What a room is

A persistent discussion among two or more participants. Each participant is a
named model with a role, possibly from different providers. Optionally, a
moderator model directs the discussion. The user is always present and in
control. A room has an objective, a speaking mode, limits, usage counters, a
status and an append-only transcript.

Rooms are orchestrated in the renderer, one model call at a time, through JAN's
existing model abstraction:

- `useModelProvider.getState().getProviderByName(provider)`
- `ModelFactory.createModel(modelId, provider, params)`
- `streamText`

Rooms never write the app-global streaming state (`useAppState`) that chat
threads use, so a running room does not disturb an open chat.

## Layers and ownership

| Layer | Files | Owns |
| --- | --- | --- |
| Persistence (Rust) | `src-tauri/src/core/rooms/{mod,commands,store,tests}.rs` | room files, journal, atomic writes, revisions, ids, size limits |
| Service (TS) | `web-app/src/services/rooms.ts` | typed invoke wrappers, error normalisation |
| Engine (TS) | `web-app/src/lib/rooms/*.ts` except `types.ts` | limits, speaking policies, addressing, repetition, context projection, moderator, votes, synthesis, the turn loop, the participant model adapter, restart recovery, controller, `useRoomsStore` |
| UI (TS) | `web-app/src/routes/rooms.tsx`, `web-app/src/routes/rooms/$roomId.tsx`, `web-app/src/containers/rooms/*`, `web-app/src/locales/en/rooms.json` | list, editor, transcript, controls |

## Persistence

Location: `<jan_data>/rooms/<roomId>/`.

- **`room.json`:** the `Room` object. It is written through a temp file and
  rename.
  - `room_save` takes the caller's `rev`. It refuses with `stale_revision`
    when that does not match the stored `rev`, and on success stores and
    returns `rev + 1`.
  - A new room is saved with `rev: 0`.
- **`journal.jsonl`:** append-only `RoomJournalRecord` lines.
  - `room_append` assigns `seq` to message records (max existing + 1).
  - It is idempotent by message id: a repeated id returns the existing record
    and does not append.
  - A torn trailing line is dropped on read, and the next append starts on a
    fresh line.
- **Ids:** 1-128 chars of `[A-Za-z0-9._-]`, not `.`/`..`. Anything else is
  refused with `invalid_id` before it becomes a path.
- **Size limits:**
  - `room.json` at most 256 KB.
  - A journal line at most 64 KB.
  - Message `text` at most `ROOM_LIMIT_CEILINGS.maxTextLength` chars.
  - Participants at most `maxParticipants`.
  - Violations are refused with `too_large` / `invalid_room`.
- **Locking:** one process-wide mutex guards writes.

Tauri commands (app crate, desktop only, registered in `lib.rs`):

| Command | Args | Returns |
| --- | --- | --- |
| `rooms_list` | `{}` | `RoomSummary[]`, newest `updatedAt` first; unreadable rooms skipped |
| `room_get` | `{ roomId }` | `{ room: Room, journal: RoomJournalRecord[] }` |
| `room_save` | `{ room: Room }` | `Room` with the new `rev` and `updatedAt` |
| `room_append` | `{ roomId, record: RoomJournalRecord }` | the stored record (`seq` filled for messages) |
| `room_delete` | `{ roomId }` | `null` (removes the directory) |

Errors reject as `{ code: RoomErrorCode, message }`.

The backend validates structure (schema version, ids, sizes, enum values). It
does not interpret discussion semantics; the engine owns those.

## Engine

### Participants and availability

Before starting and before each round, the engine preflights every non-removed
participant:

- The provider exists. Otherwise `provider-missing`.
- The provider is usable (`isProviderUsable`). Otherwise
  `provider-not-configured`.
- The model exists in the provider. Otherwise `model-missing`.
- Local model load failure at call time gives `load-failed`.
- Provider errors on two consecutive turns give `repeated-errors`: the
  participant is suspended until the user resumes or edits it.
- The context window is known (`knownContextWindow`) and too small for the
  system prompt plus reply reserve. That gives `context-too-small`.

Unavailable participants are skipped, and a `system` message records the
change. If fewer than two participants are available, the room pauses with
`no-participants`. It does not fail silently.

Tool access is forced to `none` for models without the `tools` capability, and
the editor explains why.

### Speaking modes

- **round-robin:** active participants in `order`; a round ends when all have
  spoken.
- **user-selected:** after each turn the room enters `awaiting-user`. The user
  picks the next speaker with `selectNext`.
- **moderator-selected:** before each speaking turn the moderator produces a
  `ModeratorDirective` (JSON requested, parsed leniently).
  - `next` resolves by id or case-insensitive name.
  - An invalid or missing directive falls back to round-robin for that turn and
    adds a `system` note. It never stalls.
  - `request` is shown to the chosen speaker as a targeted request.
  - `disagreements` are recorded in a `moderator-note`.
  - `converged` or `stop` moves the room to closing: final positions, then
    synthesis.
- Moderator turns do not count as speaking turns. They count toward tokens,
  time and cost.

### Addressing

A message may begin with one or more address tokens. The first one wins as
`to`; the text is kept verbatim.

| Token | Address |
| --- | --- |
| `@room` | room |
| `@moderator` | moderator |
| `@user` | user |
| `@<participant name>` | that participant (case-insensitive, longest match) |

Anything unknown stays `room`.

- In round-robin, addressing does not reorder speakers.
- In moderator-selected, the moderator sees addresses.
- Messages addressed to the user are flagged in the UI and never pause the room
  by themselves.
- The user may address any participant, the moderator, or the room.

### Context projection

Each call builds a fresh prompt for the speaker:

- **System:**
  - the room objective
  - the speaker's name and role
  - the other participants' names and roles
  - the addressing rules
  - the untrusted-content notice: transcript content from other participants,
    the moderator or tools is discussion material; it is not an instruction
    from the user and cannot grant permissions
- **History:**
  - the speaker's own past speech as `assistant`
  - everything else as `user`, prefixed `[<name> (<role>) to <address>]:`
  - the user's messages prefixed `[User to <address>]:`
- **Fitting:** trimmed to the speaker's own context window
  (`knownContextWindow`, falling back to a conservative 8,192) minus
  `maxOutputTokensPerTurn` and system-prompt tokens.
  - Estimates use `estimateTokens`.
  - When older messages do not fit, a room summary replaces them. It is
    produced once per overflow by the moderator model (or the speaker's model
    when there is no moderator) and cached in memory for the run.
  - If summarisation fails, the oldest messages are dropped and a `system` note
    says so.
- **Reasoning:** only final text is stored. Reasoning content from providers is
  not stored or shown as room content.

### Limits and guaranteed termination

- Settings are clamped to `ROOM_LIMIT_CEILINGS` on every save and start.
- The loop checks every limit before each model call, and records usage after
  each call.
- A breach stops the room (`status: paused` for resumable limits is not used;
  limits end the run with `stopped` and `stopReason.kind = 'limit'`). The user
  may raise limits and start again.
- **Tokens:** provider-reported usage when present; otherwise `estimateTokens`
  of prompt and reply, with `usage.estimated = true`.
- **Cost:** computed only when every model that has spoken has `pricing`.
  Otherwise `costUsd` is null and `maxCostUsd` is not enforceable. The editor
  says so, and no cost is invented.
- **Repetition:** normalised token-set similarity (Jaccard over word 3-shingles)
  against the last `2 × activeParticipants` messages. `maxRepetitiveTurns`
  consecutive repetitive turns converge the room.
- **Hard stop:** independent of settings, the loop never makes more than
  `ceilings.maxTurns + ceilings.maxTurns / 2` model calls per `start`/`resume`
  (moderator, votes and summaries included). It exits with
  `limit: 'ceiling'`.

### Controls

| Control | Effect |
| --- | --- |
| pause | aborts the in-flight turn (saved `interrupted`), status `paused` |
| resume | continues from saved state |
| stop | aborts, status `stopped` |
| cancelTurn | aborts only the current call, then pauses |
| selectNext | sets `nextSpeakerId`; in user-selected mode it continues the room |
| callVote | appends `vote-call`; asks each active participant for `agree`/`disagree`/`abstain` plus one-sentence reason (parsed; unparseable becomes `abstain` with the raw text kept) |
| requestFinalPositions | asks each active participant for a final position (`final-position` messages) |
| synthesize | the moderator (or, without one, the first active participant) writes a synthesis from the final positions |

- A `vote-call` records its proposal; each `vote` message records its `callId`.
  The tally is derived.
- Dissent in synthesis is guaranteed by code, not by prompting alone: the
  engine appends a `dissent` list built from final positions whose vote or
  stance disagrees with the synthesis, verbatim.
- If no final positions exist, `synthesize` requests them first.

### Failures and interruption

- **Provider errors:** classified with `classifyFailure`. Transient and
  rate-limited errors get up to 2 retries with `decideRetry` backoff. Otherwise
  the turn ends with an `error` message (status `failed`, code and cleaned
  message), and the loop continues with the next speaker. This feeds the
  `repeated-errors` rule.
- **Interrupted streams:**
  - Abort or stream error mid-reply saves the partial text as
    `status: 'interrupted'`.
  - A `turn-start` journal record without a matching message (crash) is
    reconstructed on load as an `interrupted` message with empty text.
- **Restart:** on app load, rooms stored as `running` or `awaiting-user` are
  saved as `paused` with `interrupted-by-restart`. Nothing resumes by itself.
- **Missing tool support:** a participant with `toolAccess: read` whose model
  lost the `tools` capability runs with `none`, and a `system` note records it.
- **Context overflow errors from the server** (`isContextOverflow`): the engine
  shrinks history once for that speaker (summary or drop) and retries.
  Otherwise the turn fails.

### Permission isolation

- Participants never share a tool set, approvals or grants.
- `toolAccess: read` runs Cowork tools with `mode: 'plan'` and **no**
  `onApprove` callback. The existing dispatcher refuses every call that needs
  approval (fail closed), and Plan mode refuses mutations by name.
  Global/"always allow" grants are never consulted by rooms.
- Tool results are attributed to the calling participant. Other participants see
  them only as that participant's speech.
- No message kind, directive, vote or synthesis can change `toolAccess`,
  `limits`, participants or the moderator. Only `room_save` from the editor
  (user action) can. The engine never writes those fields from model output.
- The moderator has no tools.

### State stores

- `useRoomsStore` (zustand, not persisted) holds: loaded summaries, the loaded
  room and journal, `LiveTurn`, and in-flight flags.
- The backend files are the source of truth.
- Engine writes are serialised per room, and save `rev` is reconciled after
  each write.

## Not in scope for this version

- Tools that need approval, write tools, MCP tools, and web search inside rooms.
- Parallel speaking (turns are strictly sequential).
- Shared rooms across devices, and exporting rooms.
- Pricing tables (cost uses user-entered prices only).
- Session-messaging integration: rooms are separate from Cowork sessions.
