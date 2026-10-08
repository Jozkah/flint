import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/flint-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const prepare = workflow.split('        run: |\n')[1].split('\n  build:')[0]
  .split('\n').map((line) => line.slice(10)).join('\n')
const publish = workflow.split('  publish-nightly:')[1].split('        run: |\n')[1]
  .split('\n').map((line) => line.slice(10)).join('\n')

function run(script, event, existing = 'no', stable = 'v0.9.0', expectSuccess = true, prevSha = 'b'.repeat(40)) {
  const dir = mkdtempSync(join(tmpdir(), 'flint-nightly-'))
  try {
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$1 $2" in
  'release list')
    if [[ " $* " == *" --exclude-pre-releases "* ]]; then
      echo "$MOCK_STABLE"
    else
      echo nightly-20261004-18
    fi ;;
  'release view') [ "$MOCK_EXISTING" = yes ] ;;
  'release create')
    while [ $# -gt 0 ]; do
      [ "$1" = --notes-file ] && cat "$2" >> "$MOCK_LOG"
      shift
    done ;;
  'release edit') exit 0 ;;
  'api repos/owner/flint/git/matching-refs/tags/nightly-') echo "nightly-20261004-18 $MOCK_PREV_SHA" ;;
  'api repos/owner/flint/releases/generate-notes')
    if [[ " $* " == *" previous_tag_name=nightly-20261004-18 "* ]]; then
      printf '## What'"'"'s Changed
* New fix by @owner in https://x/pull/2
'
    else
      printf '## What'"'"'s Changed
* Old feature by @owner in https://x/pull/1
* New fix by @owner in https://x/pull/2

**Full Changelog**: x
'
    fi ;;
  *) exit 3 ;;
esac
`, { mode: 0o755 })
    const output = join(dir, 'output')
    const log = join(dir, 'log')
    writeFileSync(output, '')
    writeFileSync(log, '')
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event, GITHUB_SHA: 'a'.repeat(40),
        GITHUB_REPOSITORY: 'owner/flint', GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_OUTPUT: output,
        INPUT_TAG: 'v0.9.0', TAG: 'nightly-20261006',
        RUNNER_TEMP: dir, MOCK_LOG: log, MOCK_EXISTING: existing, MOCK_STABLE: stable, MOCK_PREV_SHA: prevSha,
      },
    })
    if (expectSuccess) assert.equal(result.status, 0, result.stderr)
    return { output: readFileSync(output, 'utf8'), log: readFileSync(log, 'utf8'), status: result.status, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a fresh nightly builds the pinned commit while the release is still a draft', () => {
  const result = run(prepare, 'schedule')
  assert.match(result.output, /tag=nightly-\d{8}-\d{2}/)
  assert.match(result.output, new RegExp(`ref=${'a'.repeat(40)}`))
  assert.match(result.log, /release create .* --target a{40} --draft --prerelease --latest=false/)
  assert.match(workflow, /ref: \$\{\{ needs.prepare.outputs.ref \}\}/)
})

test('a nightly retry reuses its release without creating another draft', () => {
  const result = run(prepare, 'schedule', 'yes')
  assert.doesNotMatch(result.log, /release create/)
  assert.match(result.output, new RegExp(`ref=${'a'.repeat(40)}`))
})

test('manual release builds still check out the requested existing tag', () => {
  const result = run(prepare, 'workflow_dispatch', 'yes')
  assert.match(result.output, /ref=v0\.9\.0/)
  assert.doesNotMatch(result.log, /release create/)
})

test('publication edits the draft without a published-tag API lookup', () => {
  const result = run(publish, 'schedule', 'yes')
  assert.match(result.log, /release edit nightly-20261006 .* --draft=false --prerelease --latest=false/)
  assert.doesNotMatch(result.log, /releases\/tags/)
})

test('midnight and noon schedules follow Lisbon daylight saving time', () => {
  assert.match(workflow, /cron: '0 0,12 \* \* \*'\n      timezone: Europe\/Lisbon/)
  assert.match(prepare, /TZ=Europe\/Lisbon date \+%Y%m%d-%H/)
})


test('nightly notes list only new changes and fold older nightly changes away', () => {
  const result = run(prepare, 'schedule')
  assert.match(result.log, /release list .* --exclude-drafts --exclude-pre-releases/)
  assert.match(result.log, /previous_tag_name=v0\.9\.0/)
  assert.match(result.log, /previous_tag_name=nightly-20261004-18/)
  assert.match(result.log, /Changes since v0\.9\.0/)
  const [, afterNew] = result.log.split("## What's Changed\n")
  const [fresh, folded] = afterNew.split('<details><summary>Present from older nightly builds</summary>')
  assert.match(fresh, /New fix \(https:\/\/x\/pull\/2\)/)
  assert.doesNotMatch(result.log, /by @owner/)
  assert.doesNotMatch(fresh, /Old feature/)
  assert.match(folded, /Old feature/)
  assert.doesNotMatch(folded, /New fix/)
})

test('nightly titles do not mention Lisbon', () => {
  const result = run(prepare, 'schedule')
  assert.match(result.log, /--title Flint nightly \d{4}-\d{2}-\d{2} \d{2}:00 --notes-file/)
  assert.doesNotMatch(result.log, /--title .*Lisbon/)
})

test('a new stable release resets the nightly notes baseline', () => {
  const result = run(prepare, 'schedule', 'no', 'v0.9.1')
  assert.match(result.log, /previous_tag_name=v0\.9\.1/)
})

test('a missing stable baseline fails instead of including the whole repository history', () => {
  const result = run(prepare, 'schedule', 'no', '', false)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stable release baseline/)
  assert.doesNotMatch(result.log, /release create/)
})

test('a nightly is skipped when main has no commits since the previous nightly', () => {
  const result = run(prepare, 'schedule', 'no', 'v0.9.0', true, 'a'.repeat(40))
  assert.match(result.output, /skip=true/)
  assert.doesNotMatch(result.log, /release create/)
  assert.match(workflow, /needs\.prepare\.outputs\.skip != 'true'/)
})

test('a nightly with new commits is built', () => {
  assert.match(run(prepare, 'schedule').output, /skip=false/)
})

test('a push to main builds the commit as an artifact without touching releases', () => {
  const result = run(prepare, 'push')
  assert.match(result.output, /tag=nightly-ci-aaaaaaa/)
  assert.match(result.output, new RegExp(`ref=${'a'.repeat(40)}`))
  assert.match(result.output, /skip=false/)
  assert.doesNotMatch(result.log, /release |api /)
  assert.match(workflow, /  upload-release:\n    name: Upload the bundles to the release\n    if: github.event_name != 'push'/)
  assert.match(workflow, /push:\n    branches: \[main\]/)
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'push' \}\}/)
})

test('the build jobs hold a read-only token; only the release jobs may write', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  const jobs = workflow.split('\njobs:\n')[1].split(/\n  (?=[a-z-]+:\n)/)
  const writers = jobs
    .filter((job) => /\n    permissions:\n      contents: write/.test(job))
    .map((job) => job.split(':')[0].trim())
  assert.deepEqual(writers.sort(), ['prepare', 'prune-nightly', 'publish-nightly', 'upload-release'])
  const build = jobs.find((job) => job.trim().startsWith('build:'))
  assert.doesNotMatch(build, /gh release upload/)
  assert.match(workflow, /upload-release:[\s\S]*gh release upload/)
})

test('old nightly prereleases are pruned, keeping the newest three', () => {
  const prune = workflow.split('\n  prune-nightly:')[1].split('\n  publish-nightly:')[0]
  assert.match(prune, /if: github.event_name == 'schedule'/)
  assert.match(prune, /\.\[3:\]/)
  assert.match(prune, /14 days ago/)
  assert.match(prune, /--cleanup-tag/)
})
