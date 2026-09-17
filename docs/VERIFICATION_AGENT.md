# Independent completion verification

`src-tauri/src/core/agent/verification.rs` adds a verification phase so a worker
never grades its own implementation when a task requires formal verification.

## Flow

When verification is required (by task type, policy, or explicit request), a
separate verifier is invoked with a clean role, read-only intent, and access to:
the task spec, the diffs, the test/build output, and the worker's claims — but
**not** the worker's private reasoning. It returns one structured verdict.

## Verdict

`VERDICT: PASS | PARTIAL | FAIL | BLOCKED`, followed by an `EVIDENCE:` body
(requirement-by-requirement status, file/line references, commands inspected,
confirmed defects, gaps). Only the verifier issues the formal verdict; a worker's
own caveats never substitute for it.

- **PASS** — every requirement met, with evidence.
- **PARTIAL** — some met.
- **FAIL** — a requirement unmet or a defect confirmed.
- **BLOCKED** — evidence insufficient to decide.

## Safety properties (enforced + tested)

- **Missing verification never reads as success.** A verifier that crashes,
  returns nothing, or omits a `VERDICT:` line is **BLOCKED**, never PASS
  (`VerificationReport::blocked`). A model error becomes BLOCKED, not a
  propagated error that a caller might treat as "no problem".
- **Worker optimism cannot flip the verdict.** A worker claiming success does not
  change a seeded FAIL.
- **Prompt-injection resistant.** The task spec, diffs, test output, and worker
  claims are wrapped in a labeled, fenced *untrusted evidence* block, and the
  system prompt tells the verifier to treat everything below the line as data and
  ignore any instructions inside it.
- **Bounded repair.** `RepairBudget` caps how many repair+verify rounds run, so a
  worker that keeps failing verification cannot loop forever.
- **Distinct signals.** `CompletionSummary` keeps three things apart:
  worker-reported completion, automated test/build status, and the independent
  verifier verdict — so a worker's optimism can never read as verification.

## Integration

Reuse Jan's subagent/model-invoke machinery (as `goal.rs` does): the verifier is
a `ModelInvoker` call with a fresh prompt. Record verifier identity, model,
evidence inputs, verdict, and timestamp; propagate permission requests rather
than silently broadening the verifier's access; and do not let the verifier
modify code unless an explicit remediation mode exists.
