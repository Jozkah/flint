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
  the turn is stored as the speaker's `speech` message with `status: 'failed'`
  and an `error { code, message }` (cleaned), and the loop continues with the
  next speaker. This feeds the
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

## Implementation notes: persistence

Landed in `src-tauri/src/core/rooms/` (`store.rs` has no Tauri dependency;
`commands.rs` runs each call on the blocking pool) and
`web-app/src/services/rooms.ts`. Decisions the contract left open:

- **Arguments are parsed in the store.** `room_save` and `room_append` take
  untyped JSON and deserialise it themselves, so a malformed payload or an
  unknown enum value rejects as `{ code: "invalid_room" }` rather than Tauri's
  plain-string argument error.
- **Unknown fields are dropped.** Rooms and records are re-serialised from the
  typed structs, so a field that is not in `types.ts` does not survive a save
  or append. Add new fields to both sides.
- **Id rule scope.** The id rule applies to the room id (the path segment), and
  also to participant ids (unique within a room), message ids and turn ids;
  violations inside a room or record are `invalid_room`. `nextSpeakerId`,
  `spokenThisRound` and vote `callId` are not checked.
- **Text length** is counted in UTF-16 code units, matching JS `string.length`.
  Byte-size limits (`room.json`, journal line) are measured on compact JSON.
  Text over the limit is `too_large`; too many participants is `invalid_room`.
- **`room_save`** refuses with `stale_revision` when no file exists and `rev` is
  not 0. A stored `room.json` that cannot be read refuses the save with
  `invalid_room`; only `room_delete` recovers it. `createdAt` is kept as sent.
- **`room_append`** requires `room.json` to exist (`not_found` otherwise) and
  checks that `message.roomId` matches `roomId`. Any caller `seq` is replaced.
  Turn-start records are also idempotent, by `turnId`, so a retried turn-start
  cannot make restart recovery see two interrupted turns. Appending does not
  touch `room.json`, so `rooms_list` order reflects saves only.
- **Journal reading.** A terminated line that does not parse is skipped and
  kept on disk. An unterminated trailing line that does not parse is dropped,
  and the next append truncates it. An unterminated trailing line that does
  parse is kept, and the next append adds the missing newline first.
- **`rooms_list`** skips directories whose name fails the id rule, whose
  `room.json` is missing or unreadable, or whose stored `id` differs from the
  directory name (`room_get` reports the last as `invalid_room`). Ties on
  `updatedAt` order by id. `participantCount` counts non-removed participants;
  `turns` is `usage.turns`.
- **Error normalisation (TS).** Wrappers reject with a plain `RoomError` object.
  `toRoomError` accepts `{ code, message }` with a known code, then an Error
  message or string that starts with a known code (`code: message`), otherwise
  `unknown` with the original text.
- **Windows aliases:** the id rule also refuses a trailing `.` and reserved
  device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with
  any extension, case-insensitive), which Windows would map onto another path.
- **Testing on Windows.** The library unit tests need
  `--no-default-features --features test-tauri`, because the default
  `common-controls-v6` feature aborts the lib test harness at load (see
  `build.rs`).

## Verification

### Automated (branch `feature/discussion-rooms`)

| Check | Result |
| --- | --- |
| `cargo test -j 4 --lib --no-default-features --features test-tauri rooms` | 14 passed, 0 failed |
| `npx vitest run src/lib/rooms src/containers/rooms src/routes/__tests__/rooms.test.tsx` | 17 files, 145 passed |
| Full web vitest (before the E2E hook) | 467 files, 6273 passed, 3 skipped, 0 failed |
| `tsc -b`, `scripts/local-only-guard.mjs` | exit 0 |

### Real app against a real provider

Harness: `src-tauri/examples/cowork_smoke.rs`, `ROOMS_LANE_SCENARIOS`, run with
`COWORK_SMOKE_REAL_BASE_URL=<base> COWORK_SMOKE_ROOMS=1` in an isolated
profile. The frontend is built with `VITE_JAN_E2E_HOOKS=1`, which exposes
`window.__janRoomsE2E` (`lib/rooms/e2eHooks.ts`); without the flag the hook is
absent from the bundle (unit-tested, and checked in a flagless build).

Run on 2026-09-13 against an OpenAI-compatible vLLM endpoint. The model ids came
from its `/models` endpoint and matched the app's own provider refresh. All
five ids were served from the same weights, so this run exercises
multi-participant behaviour, not behavioural differences between distinct
models or providers.

| Scenario | Result |
| --- | --- |
| discovery (harness `/models` = app refresh) | pass |
| per-model capability probe through `streamParticipantReply` | pass, all 5 compatible |
| round-robin, all 5 models, 2 rounds (order, seq, turn-starts, shared context, self-identification, live DOM text) | pass |
| addressing in user-selected mode (`to`, `awaiting-user`, `selectNext`) | pass |
| streaming (store and DOM text strictly increasing) | pass |
| cancellation: pause, cancelTurn, stop (partial saved `interrupted`, no writes afterwards, resume) | pass |
| permission isolation (model demands approvals/tool access/limits; nothing changed) | pass |
| error handling: unserved model (2 failures, `repeated-errors`), absent model (`model-missing`), one available (`no-participants`) | pass |
| moderator-selected, vote, final positions, synthesis with verbatim dissent | pass |
| limits: `maxTurns`, `maxTotalTokens` | pass |
| restart: running room becomes paused `interrupted-by-restart` | pass |

Not covered by that run: tools-capable models and `read` tool access (no
model reported the capability, and v1 rooms advertise no tools), the context
summary/overflow path (the app used its 8,192 fallback and it was never
exceeded; the server's reported `max_model_len` is not read by the app), cost
limits (no pricing entered) and more than eight participants.

## Current limitations

- `toolAccess: 'read'` is accepted but runs without tools, with a system note.
- The context window for OpenAI-compatible servers comes from JAN's existing
  capability resolution; a server-reported `max_model_len` is not used.
- The Rooms rail entry (`lib/shellNavigation.ts` `RAIL_ITEMS`, icon in
  `components/shell/AppRail.tsx`, `common:appRail.rooms`) is applied on top of
  the Atelier shell; only the English label exists, like the other rail keys.
- No visual browser review of the rooms pages beyond the real-app harness DOM
  checks.

### After merging session messaging on fork/main (Atelier integration)

| Check | Result |
| --- | --- |
| `tsc -b`, `scripts/local-only-guard.mjs` | exit 0 |
| Full vitest | 540 files passed, 1 failed: `src/__tests__/main.test.tsx` cannot resolve `@fontsource/ibm-plex-sans/400.css`, a new dependency not installed in the shared `node_modules` (environment); 6900 tests passed |
| Rooms suites | 17 files, 145 passed |
| `cargo test -j 4 --lib --no-default-features --features test-tauri rooms` | 14 passed |

The real-provider rooms lane was not re-run after this merge.
