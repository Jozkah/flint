import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// #56: when these workflows lost their push/pull_request triggers, job guards
// that tested those events were left behind: some jobs could never run, and a
// fork-only guard silently passed on every run. Guards must fit the triggers.
const read = (name) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function triggers(text) {
  const block = text.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m)?.[1] ?? ''
  return new Set([...block.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]))
}

function jobGuards(text) {
  const jobs = text.split(/^jobs:\s*$/m)[1] ?? ''
  return [...jobs.matchAll(/^  ([\w-]+):\s*\n(?:\s*#.*\n)*\s+if:\s*(.+)$/gm)].map((m) => ({
    job: m[1],
    guard: m[2].trim(),
  }))
}

for (const name of ['jan-linter-and-test.yml']) {
  test(`${name}: every job guard can be satisfied by a trigger`, () => {
    const text = read(name)
    const on = triggers(text)
    assert.ok(on.size > 0, 'no triggers parsed')
    const guards = jobGuards(text)
    assert.ok(guards.length > 0, 'no job guards parsed')
    for (const { job, guard } of guards) {
      if (guard === 'false') continue
      const events = [...guard.matchAll(/event_name\s*==\s*'(\w+)'/g)].map((m) => m[1])
      if (events.length > 0) {
        assert.ok(
          events.some((e) => on.has(e)),
          `${job}: '${guard}' only matches events this workflow is not triggered by`
        )
      }
      if (guard.includes('github.event.pull_request') && !on.has('pull_request')) {
        assert.match(
          guard,
          /event_name\s*!=\s*'pull_request'\s*\|\|/,
          `${job}: reads pull_request fields without checking the event`
        )
      }
    }
  })
}

// Releases made with GITHUB_TOKEN emit no `release: published`, so
// release-please has to dispatch the CLI release and the website itself.
test('release-please dispatches cli release and website', () => {
  const text = read('release-please.yml')
  assert.match(text, /gh workflow run flint-cli-release\.yml .*-f tag=/)
  assert.match(text, /gh workflow run website\.yml/)
  assert.match(text, /^ {6}HAS_PAT: /m)
})

// RTE-022: without a permissions block these inherit the repo default token
// scope. They only check out code and move artifacts, so read-only is enough.
for (const name of [
  'jan-linter-and-test.yml',
  'agent-sdk.yml',
  'engine-build.yml',
  'rust-check.yml',
  'headless-server.yml',
  'cowork-sandbox-runtime.yml',
  'installer-ui.yml',
]) {
  test(`${name}: declares least-privilege permissions`, () => {
    assert.match(read(name), /^permissions:\n {2}contents: read$/m)
  })
}
