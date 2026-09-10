# janhq/jan#8007 — `defaultModel()` falls back to OpenAI cloud model ids for local providers

- Upstream: https://github.com/janhq/jan/issues/8007
- Kind: issue, open upstream
- Priority: P0 (local-to-cloud fallback)
- Status in this fork: **fixed**

## Applies to us

Yes. `web-app/src/lib/models.ts`:

```ts
export const defaultModel = (provider?: string) => {
  if (!provider || !Object.keys(models).includes(provider)) {
    return models.openai.models[0]      // 'gpt-5'
  }
  ...
}
```

`providerModels` in `web-app/src/constants/models.ts` only lists cloud
catalogues (openai, anthropic, gemini, cohere, bedrock, mistral, groq, xai,
perplexity, minimax, openrouter, nvidia). Local engines — `llamacpp`, `mlx`, any
OpenAI-compatible server the user added — are absent, so they took the OpenAI
branch and a thread could be persisted as `{ id: 'gpt-5', provider: 'llamacpp' }`.

Two call sites:

- `web-app/src/containers/ChatInput.tsx` — guarded by an earlier
  `if (!selectedModel) return`, so the fallback was mostly unreachable there.
- `web-app/src/containers/NewTemporaryChatButton.tsx` — **no guard at all**.
  Clicking the temporary-chat button with nothing selected created the invalid
  pairing directly.

## Fix

`defaultModel(provider)` now returns `string | undefined` and never borrows a
catalogue it was not asked for: no provider, or a provider with no built-in
cloud catalogue, yields `undefined`.

A new `resolveThreadModelId(provider, selectedModelId, providerModelIds)`
expresses the order of trust — the model the user selected, then the provider's
own first model, then the cloud catalogue for cloud providers only. Both call
sites use it and refuse to open a thread when it yields nothing:

- `ChatInput` sets the existing "Please select a model to start chatting."
  message.
- `NewTemporaryChatButton` does not create the thread and does not navigate.

## Verification

```
vitest src/lib/__tests__/models.test.ts                      53 passed
vitest src/containers/__tests__/NewTemporaryChatButton.test.tsx  3 passed
vitest src/containers/__tests__/ChatInput{,.simple}.test.tsx    34 passed
yarn typecheck (tsc -b)                                      exit 0
```

The pre-existing `defaultModel` tests asserted the buggy behaviour
(`defaultModel('unknown') === 'gpt-5'`) and were rewritten to assert the
local-safe contract.
