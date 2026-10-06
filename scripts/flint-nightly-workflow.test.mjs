import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const workflow = readFileSync(new URL('../.github/workflows/flint-release.yml', import.meta.url), 'utf8')
const prepare = workflow.split('        run: |\n')[1].split('\n  build:')[0]
  .split('\n').map((line) => line.slice(10)).join('\n')
const publish = workflow.split('  publish-nightly:')[1].split('        run: |\n')[1]
  .split('\n').map((line) => line.slice(10)).join('\n')

function run(script, event, existing = 'no', stable = 'v0.9.0', expectSuccess = true) {
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
      echo nightly-20261004
    fi ;;
  'release view') [ "$MOCK_EXISTING" = yes ] ;;
  'release create'|'release edit') exit 0 ;;
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
        GITHUB_REPOSITORY: 'owner/flint', GITHUB_OUTPUT: output,
        INPUT_TAG: 'v0.9.0', TAG: 'nightly-20261006',
        MOCK_LOG: log, MOCK_EXISTING: existing, MOCK_STABLE: stable,
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


test('nightly notes include all changes since stable even when earlier nightlies exist', () => {
  const result = run(prepare, 'schedule')
  assert.match(result.log, /release list .* --exclude-drafts --exclude-pre-releases/)
  assert.match(result.log, /--notes-start-tag v0\.9\.0/)
  assert.match(result.log, /Changes since v0\.9\.0/)
  assert.doesNotMatch(result.log, /--notes-start-tag nightly-/)
})

test('a new stable release resets the nightly notes baseline', () => {
  const result = run(prepare, 'schedule', 'no', 'v0.9.1')
  assert.match(result.log, /--notes-start-tag v0\.9\.1/)
})

test('a missing stable baseline fails instead of including the whole repository history', () => {
  const result = run(prepare, 'schedule', 'no', '', false)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stable release baseline/)
  assert.doesNotMatch(result.log, /release create/)
})
