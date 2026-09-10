# Upstream item notes

One file per upstream issue or pull request that this fork has actually acted
on. The machine-readable ledger lives in `docs/upstream-issues-prs.json`; these
notes carry the reasoning, the reproduction evidence and anything a later
session needs that does not fit a JSON field.

Naming: `<number>-<slug>.md`, where `<number>` is the upstream issue/PR number
on `janhq/jan`.

Untriaged items have no file here — absence means "not looked at yet", not
"nothing to do".

## Regenerating the ledger

```bash
# refresh the GitHub cache (writes .upstream-cache/, which is git-ignored)
bash scripts/upstream-intake/fetch.sh

# rebuild the ledger, preserving every triage decision already recorded
node scripts/upstream-intake/build-queue.mjs

# record a decision
node scripts/upstream-intake/set-record.mjs 8067 '{"implementationStatus":"fixed"}'
```
