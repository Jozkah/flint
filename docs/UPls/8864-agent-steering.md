# Steer a running agent with user messages (janhq/jan#8864)

Upstream PR #8864 (merged upstream as `dc40d7c27`) lets the terminal agent
take input while it is working. Before, text typed during a run was queued
and only reached the model as a new run after the current one ended. The fork
had drifted about 1.7k lines in the files it touches, so this is a hand port.
The unrelated `flappy-hamster.html` in the PR is not taken.

## Behaviour

- Typing while the agent works makes the message *pending*. It reaches the
  model at the next safe boundary:
  - after every tool result of the current turn is in and before the next
    model call;
  - or, if the model is writing its final answer, right after it. The answer
    and its reasoning go into the history, then the input, and the same run
    continues.
- Pending input is handed over in submission order, with its images, its
  `@path` contents (frozen at submit time) and a `/skill:` expansion.
- Nothing is handed over while a permission prompt or an `ask` is open. Input
  typed in a different run mode (plan vs normal) waits for a new run.
- Esc / Ctrl-C still cancel. Anything not yet handed over stays pending and
  goes out by the ordinary next-run path, as does input that a boundary could
  not deliver.
- `/cancel` removes pending messages. The UI says "pending" and "type to
  steer the agent" instead of "queued".

## Fork-specific

- The fork retries an empty or reasoning-only reply once (janhq/jan#8712)
  where upstream put the final boundary. Steering at the final answer runs
  after that retry and only for a non-empty answer, so an empty assistant
  message is never sent. It runs before the todo closeout nudge, so the
  correction is not buried under a reminder.
- Only the TUI passes a steering channel. The API server, headless runs and
  subagents pass none and never wait on a handoff.

## Tests

- `core/agent/loop.rs`, the three upstream tests:
  - `steering_enters_after_all_tool_results_in_submission_order`
  - `steering_during_final_response_continues_the_same_run`
  - `steering_disconnected_surface_does_not_block_the_loop`
- Plus the fork's own `steering_is_not_offered_an_empty_final_reply`.
- `core/cli/tui.rs`, the ten upstream handoff tests: images, paths, order and
  transcript; cancel; permission prompt; failed handoff; plan transition;
  event order; error and cancel fallback; session reset; resume; skill
  expansion. Existing render tests are updated for the new wording.
