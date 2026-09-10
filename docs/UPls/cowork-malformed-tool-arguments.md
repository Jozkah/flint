# Malformed tool-call arguments broke the rest of a conversation

Not an upstream item; the same class as janhq/jan#8519's missing `arguments`.
Found by the real-WebView regression scenario `a-malformed-tool-call-fails-cleanly`
in batch 3. Fixed in `613e25b` (with `e222a77`, see below).

## Symptom

A model sent tool-call arguments that were not JSON (`read:{"path":`). The
call was refused and the run ended cleanly, the conversation survived a
reload -- and then the session never answered again.

## Cause

The AI SDK reports such a call as invalid (`tool-input-error`) and carries the
raw text as its `input`. The Cowork runner kept that string as the failed
call's input and wrote it into the history, so every later request replayed a
tool call whose input is a string, not an object, which a chat template cannot
render. Regular chat has the same exposure on reload: `messages.ts` keeps an
unparseable stored argument string as the input.

Reproduced by `replays with an object input when the arguments were not JSON`
(`web-app/src/lib/__tests__/coworkRunner.test.ts`), which runs the history
through the real `convertToModelMessages` and fails on the old runner.

## Fix

- The runner gives a failed call an object input (`{}`) and puts the raw text
  in the refusal, so the model still sees what it sent.
- `resolveOrphanToolCalls`, which already repairs tool parts immediately before
  `convertToModelMessages` for chat and Cowork alike, replaces any tool input
  that is not an object -- which also heals threads saved with a string input.
  Covered by `replaces a tool input that is not an object, keeping the call`
  (`custom-chat-transport.test.ts`), which fails on the old code.

## Process note

`613e25b` staged `web-app/src/lib/custom-chat-transport.ts` by path, and that
file also held six lines of the user's uncommitted work (`ServiceHub.app()`),
which were swept into the commit. `e222a77` removes exactly those lines from
the committed file via an index-only blob, leaving the working tree untouched;
the user's uncommitted diff was then verified identical to the session-start
baseline except for the `index` blob line of that one file.
