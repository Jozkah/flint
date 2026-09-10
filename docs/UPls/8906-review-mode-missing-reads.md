# janhq/jan#8906 — repeated missing-file reads during a file-creation task

- Upstream: https://github.com/janhq/jan/issues/8906 (open; the reporter's
  fix is described in comments but not published)
- Priority: P1
- Status in this fork: **fixed** (`9e2b7af`)

## Reproduced from the report

Plan mode on, empty workspace, "create an HTML page": the model reads
`index.html`, gets "No such file or directory", says it will create it, and
reads it again. The fork's equivalent is Cowork review mode
(`web-app/src/lib/coworkDispatch.ts`): every writing tool is withheld and
refused by name, and a `read` error went back to the model bare. Nothing
bounded the loop. Separately, `plan_review` answers were rendered back to the
model as JSON and nothing else: `EXECUTE_PLAN_LABEL` and friends were exported
and never used, so choosing Execute plan could not make the session writable.

Reproduction: `missing reads in review mode` in
`web-app/src/lib/__tests__/coworkDispatch.test.ts` — before the change each
repeated read executed and returned only the raw error, and `onAsk` was never
called.

## Fix

- First missing-path `read` in review mode: the real error, then an
  explanation that `read` cannot create the file and how to hand the plan to
  the user.
- Second `read` of the same missing path in the same run: not executed; the
  user gets a `plan_review` question (Execute plan / Keep planning / Exit plan
  mode) and the model gets the original error plus the answer. History is a
  per-run map shared with the run's children.
- Answering: Execute plan or Exit plan mode sets the session to **Ask** (never
  Auto) from the next message — the run's tool set is frozen, so the current
  run is told it stays read-only and to end the turn. Keep planning, a custom
  answer or a dismissed card changes nothing.

Unchanged: other errors, other modes, the write refusals.

## Verification

```
vitest coworkDispatch.test.ts + coworkPlanReview.test.ts   59 passed
vitest cowork.route.test.tsx                                22 passed
yarn workspace @janhq/web-app typecheck                     exit 0
```

A model-in-the-loop replay (as the reporter did with Qwen3.5-9B) has not been
run here; the v100 lane exercises Cowork against a real model.
