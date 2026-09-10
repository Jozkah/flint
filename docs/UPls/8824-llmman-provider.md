# janhq/jan#8824 — add llmman as a predefined provider

- Upstream PR: https://github.com/janhq/jan/pull/8824 (open, by ericcurtin)
- Priority: P3 (local provider coverage)
- Status in this fork: **adapted**, applied as reviewed with our own tests

## Review

Two files, +23 lines: a `llmman` entry in `web-app/src/constants/providers.ts`
(base URL `http://localhost:17434/v1`, no API key, a base-URL setting, an
`explore_models_url` opened only on click) and a `getProviderTitle` case so the
name stays lowercase. No dependency, network or permission change.

## Local-only check

Adding a preset must not add traffic. `syncRemoteProviders`
(`web-app/src/providers/DataProvider.tsx`) registers a provider with the
backend only when it is active **and** has API keys, and llmman has none. So the
entry sits in the list and costs nothing until the user points a chat at it.

## Tests (ours; the PR had none)

`web-app/src/constants/__tests__/providers.llmman.test.ts`: the preset exists,
its base URL is loopback, it carries no key and `providerHasRemoteApiKeys` is
false for it, and its title stays `llmman`.

```
vitest providers.llmman.test.ts + utils.test.ts   64 passed
yarn typecheck                                    exit 0
```
