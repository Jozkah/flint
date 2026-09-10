# janhq/jan#8096 — clicking stop does not terminate the chat connection

- Upstream: https://github.com/janhq/jan/issues/8096
- Kind: issue, open upstream
- Priority: P1 (cancellation)
- Status in this fork: **already fixed**

## Why this fork is not affected

Cancellation is carried end to end already.

`web-app/src/containers/ChatInput.tsx` aborts the thread's `AbortController`;
`streamText` receives it as `abortSignal`
(`web-app/src/lib/custom-chat-transport.ts`); and the transport underneath is
`web-app/src/lib/providerFetch.ts`, which names each request with a `streamId`
and invokes the `provider_http_cancel` Tauri command on abort — and again if the
consumer merely releases the response body:

```ts
const stop = () => {
  if (stopped) return
  stopped = true
  void invoke('provider_http_cancel', { streamId }).catch(() => {})
}
```

Rust side, `cancel_stream` in `src-tauri/src/core/net/transport.rs` sets the
flag the streaming loop checks, so the upstream request is dropped rather than
read to completion.

## Existing coverage

`web-app/src/lib/__tests__/providerFetch.test.ts` already pins all three paths:
cancel on abort, cancel when the body is released, and no cancel for a stream
the transport already ended.

No production change was needed. Recorded so the item is not picked up again.
