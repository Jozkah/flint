# Steer a running agent with user messages (janhq/jan#8864)

Upstream PR #8864 (merged upstream as `dc40d7c27`) lets the terminal agent
take input while it is working. Before, text typed during a run was queued
and only reached the model as a new run after the current one ended. The fork
had drifted about 1.7k lines in the files it touches, so this is a hand port.
The unrelated `flappy-hamster.html` in the PR is not taken.

The desktop's Cowork surface had the same gap. It now has the same behaviour,
through its own runner.

## Behaviour (both surfaces)

- Typing while the agent works makes the message *pending*. It reaches the
  model at the next safe boundary:
  - after every tool result of the current step and before the next model
    call;
  - or, if the model is writing its final answer, right after it. The answer
    stays in the history, the input follows, and the same run continues.
- It is delivered as the user's own message, never folded into the model's
  turn, and several messages keep the order they were typed in.
- Input belongs to the session it was typed in. Another session's run never
  receives it, whichever session is in view.
- Steering changes nothing about what the run may do. It is a user message
  like any other, so permissions, approvals, workspace confinement, plan mode
  and tool restrictions apply unchanged at dispatch.

## Terminal (hand port of upstream)

- A handoff channel from the loop (`SteeringRequest`) is offered at each
  boundary. Nothing is handed over while a permission prompt or an `ask` is
  open, or across a plan/normal mode change.
- Input not handed over stays pending and goes out by the ordinary next-run
  path.
- Esc / Ctrl-C still cancel. `/cancel` removes pending messages. The UI says
  "pending" and "type to steer the agent".
- Fork-specific:
  - The fork retries an empty or reasoning-only reply once (janhq/jan#8712)
    where upstream put the final boundary. Steering at the final answer runs
    after that retry and only for a non-empty answer, so an empty assistant
    message is never sent. It runs before the todo closeout nudge.
  - Only the TUI passes a steering channel; the API server, headless runs
    and subagents never wait on a handoff.

## Desktop (Cowork)

- `runTurn` takes a `takeSteering` hook, called at the same two boundaries.
  The route hands it the session's own queue (the composer already queued
  input typed during a run).
- Each message has an explicit state:
  - **Pending.** Shown as the composer's queued chips.
  - **Delivered.** Taken off the queue and shown in the transcript where it
    entered the conversation, labelled "Sent to the agent while it was
    working".
  - **Typed after the run finished.** Sent as the next request once the
    session is idle, visibly, as it was before.
  - **Held.** When the run it was typed for failed, was stopped, hit a limit,
    or never started, the input is held rather than dropped (the queue used
    to be cleared silently on an error) or sent on its own (it used to go
    after a Stop). The session shows it with Send and Discard.
  - **Deleted.** Deleting the session removes its pending input with it.
  - **After a restart.** Pending input is mirrored into the persisted session
    and comes back held after a restart.

## Tests

- `core/agent/loop.rs`:
  - the three upstream tests: `steering_enters_after_all_tool_results_in_submission_order`,
    `steering_during_final_response_continues_the_same_run`,
    `steering_disconnected_surface_does_not_block_the_loop`;
  - the fork's own `steering_is_not_offered_an_empty_final_reply`.
- `core/cli/tui.rs`: the ten upstream handoff tests.
- `web-app/src/lib/__tests__/coworkRunner.test.ts` (`steering a running
  turn`): delivery after the tool round, in order; continuing the same run
  at the final answer; nothing taken after a stop. Each failed before the
  hook existed.
- `web-app/src/stores/__tests__/message-queue-store.steering.test.ts`: ready
  vs held; hold; release; restore as held.
- `web-app/src/routes/__tests__/cowork.sessions.test.tsx`: a running session
  gets only its own input, marked as steering; a failed run's input is held
  and not sent; input after a finished run is the next request.
- `web-app/src/containers/__tests__/CoworkHeldInput.test.tsx`.
- Real app: `steering-reaches-the-running-session-at-its-next-boundary` in
  `src-tauri/examples/cowork_smoke.rs`.
  - Two messages are typed while session A's first step streams.
  - The model's request after the tool round carries both, in order, as user
    messages after the tool result; the first request carried neither.
  - The transcript marks both as steering.
  - A request from session B carries neither.
