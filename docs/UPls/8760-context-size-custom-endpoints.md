# janhq/jan#8760 (fixes #8669) — Increase Context Size for custom OpenAI endpoints

- Upstream PR: https://github.com/janhq/jan/pull/8760 (open, by gokay-ai)
- Upstream issue: https://github.com/janhq/jan/issues/8669
- Priority: P1 (context-window failure on custom endpoints)
- Status in this fork: **in progress** — misclassification fixed; the increase
  action is still open

## What applies to us

Both defects the PR describes exist here, in
`web-app/src/routes/threads/$threadId.tsx`:

1. **A fake 32k cap.** On a `finishReason: 'length'` stop the route read
   `ctx_len` and used `?? 32768` when it was missing. Custom OpenAI-compatible
   models have no `ctx_len`, so a large model cut off by its output cap at ~30k
   tokens raised the out-of-context banner, and a small model that really
   overflowed did not.
2. **An increase that changes nothing.** `handleContextSizeIncrease` raises
   `ctx_len` in the store and, for any provider other than llama.cpp, calls
   `stopModel` — a no-op for a remote endpoint. Nothing sent to that server
   depends on `ctx_len`, so the retry hits the same limit.

## Why not port the PR

It adds a parallel `model-context-size` module and a new persisted Context Size
for custom models. This fork already resolves windows from every source it has
(AH-195: user setting, the limit a server reported when it refused a request,
provider metadata, local runtime, bundled table) and learns limits from
refusals per endpoint (`web-app/src/lib/contextLimitRecovery.ts`). A second
mechanism would disagree with the first.

## Done

`web-app/src/lib/knownContextWindow.ts` resolves the window the capability
display uses, and `stoppedAtContextLimit` never returns a verdict for an unknown
window. The route uses them. An unknown window now leaves the partial reply as a
stopped turn the user can continue, instead of a banner offering a fix that
cannot work.

```
vitest src/lib/__tests__/knownContextWindow.test.ts       9 passed
vitest src/routes/threads/__tests__/$threadId.test.tsx   36 passed
yarn typecheck                                            exit 0
```

## The increase action

`contextIsResizable(provider)` is true only for llama.cpp and MLX, where Jan
sets the window when it loads the model. The banner offers **Increase Context
Size** only there. For every other provider it explains that the server owns the
window and offers Regenerate, instead of a button that raised a setting nothing
sent.

Making the route test reach this path also fixed its `@/utils/error` mock, which
dropped the real parsers the banner calls (`parseContextOverflow`), so the
context banner had never been renderable in that suite.

```
vitest src/lib/__tests__/knownContextWindow.test.ts       11 passed
vitest src/routes/threads/__tests__/$threadId.test.tsx   37 passed
```

Mutation: forcing the gate to `true` fails
`offers Increase Context Size only where Jan sets the window`.

Status: **adapted**.
