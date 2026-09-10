# Shell injection through workflow inputs (janhq/jan#7871)

Upstream PR #7871 (closed, unmerged) made the manual portable build's
`channel` input a choice and added a "Validate channel input" step to three
templates. That step read the input as `CHANNEL="${{ inputs.channel }}"` inside
its own script, so the value was still spliced into shell before being checked:
the check itself was injectable. The diff also no longer applies. Reimplemented.

## What was wrong in the fork

- `manual-build-portable.yml` took `channel` as free text and ran
  `janhq/jan/.github/workflows/template-tauri-build-windows-x64.yml@main` --
  upstream's template, not this repository's -- with `secrets: inherit`. Any
  change upstream made to that file ran with this repository's secrets.
- Every build template interpolates `inputs.channel` and `inputs.new_version`
  directly into `run:` scripts (`if [ "${{ inputs.channel }}" != ... ]`,
  `sed -i "s/.../Jan-${{ inputs.channel }}/g"`, S3 paths, ...). A crafted value
  from any caller -- the manual dispatch, or the flatpak build's free-text
  `version` -- ran as shell in a job holding signing and upload secrets.

## Fix

- The manual build offers `stable` / `beta` / `nightly` as a choice and runs
  this repository's own template (`./.github/workflows/...`).
- Each template's job now starts with a `Validate inputs` step that receives
  `channel` and `new_version` only through `env:` and stops the job unless the
  channel is one of `stable`, `beta`, `nightly`, `agent-nightly` and the version
  looks like `1.2.3` or `1.2.3-suffix`. Every later interpolation therefore sees
  only an allowlisted value. The release-notes template checks the version.

## Test

`scripts/workflow-inputs-guard.test.mjs` (part of `yarn test:scripts`):

- every template input used in a script is validated by an earlier step;
- the validation script never interpolates `${{ }}` itself;
- no workflow runs a reusable workflow from another repository;
- the manual build's channel is a choice.

Against the pre-fix workflows the first, third and fourth fail; the second has
no validation step there to inspect. Not exercised on GitHub's runners
from here: the step is plain bash, and the workflows parse with PyYAML.
