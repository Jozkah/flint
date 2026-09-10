# janhq/jan#8495 — AI replies disappear from the UI in a branched thread

- Upstream: https://github.com/janhq/jan/issues/8495
- Kind: issue, open upstream (no upstream PR)
- Priority: P0 as classified (content present on disk, missing from the UI)
- Status in this fork: **fixed** for the mechanism found; reporter's exact file
  not available

## What was found in this fork

The reporter's thread is not available, and their tree description is partly
guesswork (several `activeChildId` values are marked `?`). Rather than fit a
fix to that guess, the question was: what, in this fork, can make messages
that exist in `messages.jsonl` unreachable from the active path?

`computeActivePath` (`web-app/src/lib/message-branching.ts`) walks from the root
down each node's active child. A message is invisible exactly when no walk can
reach it. The existing repair (`repairDetachedAssistants`, upstream #8357)
handles assistants with a `null`/missing parent. It does not handle a parent
that **names a message that no longer exists**, and two production paths
create exactly that:

1. **Deleting a message.** `handleDeleteMessage` in
   `web-app/src/routes/threads/$threadId.tsx` removed only the row. Its children
   kept a `parentId` pointing at nothing, and everything below it vanished.
2. **Load-time cleanup of empty assistant rows.** Errored generations used to be
   persisted as empty assistant messages, and the next user turn was linked to
   that row because it was last on the active path. The loader deleted the empty
   rows — and with them every later turn.

Reproduced as a failing pure test (`reproduces the loss: dropping a row strands
everything below it`) and as a failing route test with the fix mutated out.

## Fix

- `removeFromTree(messages, ids)` re-parents the children of removed messages to
  the removed message's own parent (walking past chains of removed messages) and
  moves a parent's `activeChildId` onto the child that took the removed
  message's place. Used by both the delete handler and the empty-row cleanup.
- `repairDanglingParents(messages)` runs on load for threads already damaged:
  a message whose parent is gone is hung off the nearest earlier message by
  `created_at` and selected when that parent's own selection is missing.
- The delete handler re-renders from the active path in branched threads
  instead of filtering one id out of the rendered list.

## Verification

```
vitest src/lib/__tests__/message-branching.test.ts          26 passed
vitest src/routes/threads/__tests__/$threadId.test.tsx      34 passed
full JS suite                                               5991 passed, 3 skipped
yarn typecheck                                              exit 0
```

Mutation: removing the `removeFromTree` call from the delete handler fails
`delete re-links what hung below the message before removing it`.

## Open

If the reporter's thread has a shape neither path produces, this does not cover
it. Their `messages.jsonl` (redacted) would settle it.
