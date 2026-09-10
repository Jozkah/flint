# janhq/jan#8524 — system prompt changes not applied mid-chat

- Upstream: https://github.com/janhq/jan/issues/8524
- Kind: issue, open upstream
- Priority: P1 (the conversation ignores the user's instructions)
- Status in this fork: **fixed**

## Root cause in this fork

The report blames llama.cpp's KV cache. That cannot produce this on its own: a
changed system prompt changes the prefix tokens, and prompt caching only reuses
an identical prefix. The stale instructions were in the request itself.

`web-app/src/routes/threads/$threadId.tsx` builds the system prompt from
`thread.assistants[0].instructions` — a **copy** of the assistant stored on the
thread when it was created or switched. `useAssistant.updateAssistant`
(`web-app/src/hooks/useAssistant.ts`) updated the assistant list, the current
assistant, and the assistant file on disk, and never touched those copies. So
editing an assistant's instructions left every open conversation using the old
ones.

## Fix

`updateAssistant` now refreshes the copy in every thread whose assistant has the
edited id, through `useThreads.updateThread` (which persists), keeping each
thread's own `model` binding. Threads bound to another assistant are untouched.

## Verification

```
vitest src/hooks/__tests__/useAssistant.test.ts            10 passed
vitest src/hooks/__tests__/useAssistant.coverage.test.ts   14 passed
vitest src/hooks/__tests__/useThreads.test.ts              15 passed
yarn typecheck                                             exit 0
```

`carries an edited assistant into the threads that use it` failed against the
old store with `expected 'Answer in Spanish.' to be 'You are a pirate.'`.

## Not taken

The report suggests invalidating the KV cache for the system-prompt prefix or
adding an "Apply to current chat" button. Neither is needed once the request
carries the current prompt.
