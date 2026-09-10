// Guards the CI workflows against shell injection through workflow inputs and
// against running reusable workflows this repository does not control
// (janhq/jan#7871).
//
// The build templates interpolate `inputs.channel` and `inputs.new_version`
// straight into shell scripts. Rewriting every one of those lines is not
// needed as long as each job first checks the two values against an allowlist
// -- reading them only through the environment, so the check itself cannot be
// injected -- and stops on anything else.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(here, '..', '.github', 'workflows')
const workflows = fs
  .readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, lines: fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/) }))

/** Lines that put an input into a script, as opposed to a `key: ${{ ... }}` value. */
function scriptUses(lines, input) {
  const needle = `\${{ inputs.${input} }}`
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes(needle))
    .filter(({ line }) => !/^\s+[A-Za-z_-]+:\s+"?\$\{\{ inputs\.[a-z_]+ \}\}"?\s*$/.test(line))
    .filter(({ line }) => !line.trimStart().startsWith('#'))
}

/** The `Validate inputs` step: its start and end line indexes. */
function validationStep(lines) {
  const start = lines.findIndex((l) => /^\s+- name: Validate inputs\s*$/.test(l))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && /^\s+- name: /.test(l))
  if (end < 0) end = lines.length
  return { start, end, body: lines.slice(start, end) }
}

test('every input a template puts into a script is validated first', () => {
  for (const { name, lines } of workflows.filter((w) => w.name.startsWith('template-'))) {
    for (const input of ['channel', 'new_version']) {
      const uses = scriptUses(lines, input)
      if (uses.length === 0) continue
      const step = validationStep(lines)
      assert.ok(step, `${name} puts inputs.${input} into a script with no Validate inputs step`)
      const envName = input === 'channel' ? 'CHANNEL' : 'NEW_VERSION'
      assert.ok(
        step.body.some((l) => l.trim() === `${envName}: \${{ inputs.${input} }}`),
        `${name}: Validate inputs does not check inputs.${input}`
      )
      for (const use of uses) {
        assert.ok(
          use.index > step.end - 1,
          `${name}:${use.index + 1} uses inputs.${input} before it is validated`
        )
      }
    }
  }
})

test('the validation step reads inputs only through its environment', () => {
  for (const { name, lines } of workflows) {
    const step = validationStep(lines)
    if (!step) continue
    const run = step.body.findIndex((l) => /^\s+run: \|\s*$/.test(l))
    assert.ok(run >= 0, `${name}: Validate inputs has no run block`)
    for (const line of step.body.slice(run + 1)) {
      assert.ok(!line.includes('${{'), `${name}: the validation script interpolates: ${line.trim()}`)
    }
  }
})

test('no workflow runs a reusable workflow from another repository', () => {
  for (const { name, lines } of workflows) {
    for (const line of lines) {
      const m = line.match(/^\s+uses:\s+([^\s#]+)/)
      if (!m || !m[1].includes('.github/workflows/')) continue
      assert.ok(
        m[1].startsWith('./'),
        `${name} runs ${m[1]}, a workflow this repository does not control`
      )
    }
  }
})

test('the manual portable build offers a fixed set of channels', () => {
  const { lines } = workflows.find((w) => w.name === 'manual-build-portable.yml')
  const channel = lines.findIndex((l) => /^\s+channel:\s*$/.test(l))
  const block = lines.slice(channel, channel + 10).join('\n')
  assert.match(block, /type: choice/)
})
