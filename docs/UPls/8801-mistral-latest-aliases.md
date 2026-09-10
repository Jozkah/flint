# janhq/jan#8801 — tools and vision for Mistral's `-latest` aliases

- Upstream PR: https://github.com/janhq/jan/pull/8801 (open, by dawNotPoi)
- Priority: P3 (capability metadata for a remote provider)
- Status in this fork: **adapted** (`0d1dbf0`), applied as reviewed

## Review

Two files: `web-app/src/constants/models.ts` gains `mistral-small-latest` and
`mistral-medium-latest` in the Mistral catalogue with their streaming, tool and
vision capabilities, and `web-app/src/lib/__tests__/models.test.ts` gains a
parameterised test. No dependency, network or permission change; the catalogue
only describes a provider the user has configured themselves.

Applied cleanly with `git apply` (two hunks offset by upstream/fork drift).

## Why take it

Without the entries, choosing either alias left `tools` out of the request and
hid image input, although both aliases support them.

## Verification

```
vitest src/lib/__tests__/models.test.ts   55 passed
```
