# janhq/jan#7939 — built-in RAG fails when a model serializes tool arguments as strings

- Upstream: https://github.com/janhq/jan/issues/7939
- Kind: issue, open upstream
- Priority: P1 (tool-call failure on OpenAI-compatible providers)
- Status in this fork: **fixed**

## Applies to us

Yes. `extensions/rag-extension/src/index.ts` read its numeric arguments with a
TypeScript cast, which is a no-op at runtime:

```ts
const startOrder = args['start_order'] as number | undefined
const topK = (args['top_k'] as number) || s.retrievalLimit || 3
const fileIds = args['file_ids'] as string[] | undefined
```

A model that emits `{"start_order": "0"}` therefore passed the string straight
to the strictly typed Rust vector engine, which answered
`invalid type: string "0", expected i64`. The same for `top_k` reaching a
`usize`, and for a `file_ids` list serialized as JSON text.

This is not one bad model. Whole runtimes — the reporter hit it with FastFlowLM
on an NPU — serialize every argument value as a string regardless of the
declared schema type. For a fork whose point is supporting arbitrary local and
OpenAI-compatible servers, rejecting them is the wrong default.

## Fix

`extensions/rag-extension/src/args.ts` narrows the values at the intake layer:

- `coerceIntegerArg` accepts a number or its string spelling (`"5"`, `" 6 "`,
  `"+7"`, `"5.0"`), and returns undefined for anything that is not an exact,
  safe integer — `"6.5"`, `"abc"`, `""`, `NaN`, `Infinity`, booleans, objects.
  A malformed argument still fails; it just fails as "missing parameter" rather
  than as an engine type error.
- `coerceStringArrayArg` accepts a real array, the JSON text of one, or a bare
  id as a single-element list, and drops empty and non-string entries.

Both are deliberately narrow: they recover the declared type or give up. They
never guess a value.

## Verification

Against the unfixed intake the new integration cases fail — for example
`expected "0" to be 0` from `getChunks`, and `searchCollection` receiving
`"6"` where the engine wants a `usize`. After the fix:

```
vitest --project @janhq/rag-extension    57 passed (3 files)
```
