# Cowork runs belong to their session (janhq/jan#8905)

Upstream PR #8905 (merged upstream) isolates concurrent Cowork session runs.
Its diff does not apply to the fork's Cowork route, so this is an attributed
reimplementation on the fork's architecture.

## What was wrong in the fork

The route held one run for the whole page:

- `running`, the live turns, the outcome, the usage and the readiness numbers
  were page state, so a run in session A made session B look busy and drew A's
  live rows under B.
- Stop aborted a single `abortRef` -- whichever run started last, in any
  session -- and settled every pending question on the page.
- Questions, the prompt snapshot and a retake's skills were page-global too.
- The model was the global picker, and the transport re-read it on every step:
  choosing a model while viewing one session changed another session's run
  already in progress.
- Deleting a running session left its run streaming into a session that no
  longer existed. Queued messages were never sent.

The runner already kept cancellation handles per session; the route ignored
them.

## Fix

- `useCoworkRun` gains `runs` (the run each session has in flight) and
  `outcomes`. Every live-lane write and the run's ending name the run id and
  are refused when the session no longer has that run -- stopped and replaced,
  or deleted -- so a late event lands nowhere.
- The route claims the session before its first await: run id, cancellation
  handle (`beginRun`), running state. Stop calls `abortRun(viewedSession)`
  only; questions are held by that run's handle and answered only through
  that session.
- Each session stores its own `model`, persisted with the session. The run
  captures it at start and the Cowork transport sends every step with it
  (`getModelSelection`, a new seam on the chat transport). The picker shows
  and writes the viewed session's model.
- `deleteCoworkSession` stops that session's run, drops its run state, pending
  approvals and queue, and then deletes it.
- Queued messages stay with their session and go when that session is in view
  and idle.
- The sidebar marks every running session, without the viewed one being
  treated as busy. The shared model-load card is taken down only by the last
  run to finish.

Not changed: the stop menu still sends the backend stop with the session id
as its run filter; that request is scoped by session, so it cannot reach
another session's tools.

## Found by the real-app scenario

The two-session Stop scenario failed on the first build: B stayed marked as
running for 30 s after Stop. Instrumented, the abort reached B's controller at
once, but B's run only ended 40 s later. Three places waited on something that
did not watch Stop:

- The run is claimed before it prepares (sandbox probe, tool list, Git
  baseline, engine probe), and that preparation sat outside the turn's
  try/finally. Stop during it did nothing until the preparation finished;
  a probe that threw left the session running for good. Preparation steps now
  give up the moment Stop is pressed and end the run, keeping the user's
  message, and a failing one ends it with the error.
- `runTurn` awaited the transport's `sendMessages` and the stream's reads
  without watching the signal, so a request still waiting for its response to
  start, or a stream the transport did not close, outlived Stop.
  `untilStopped` races both against the signal and releases a stream that
  arrives late.

These are pre-existing: the old page-wide Stop had the same waits.

## Tests

- `hooks/__tests__/useCoworkRun.sessions.test.ts`: per-session runs, refused
  late writes, outcomes, deletion.
- `routes/__tests__/cowork.sessions.test.tsx`: two sessions through the real
  route with runs held open -- busy state, concurrent runs with distinct
  signals, Stop scoping, completion / failure / question / tool dispatch /
  approval arriving after a switch, per-session model and picker. Mutation
  checks: a page-wide running flag, Stop aborting every run, and a run not
  bound to its model each make a test fail.
- `lib/__tests__/coworkSessionLifecycle.test.ts`, `coworkTransport.test.ts`,
  `hooks/__tests__/useCoworkSessions.model.test.ts`.
- Stop while preparing / preparation failing (`cowork.sessions.test.tsx`),
  and Stop with a stream that never ends or a request that never starts
  streaming (`coworkRunner.test.ts`). Each failed on the code before its fix.
- Real-WebView scenario `stop-cancels-only-the-selected-session`.
