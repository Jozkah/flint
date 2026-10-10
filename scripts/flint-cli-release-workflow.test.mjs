import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TARGETS } from './render-package-manifests.mjs'

// The release workflow, the manifest renderer and the npm launcher must agree
// on the target list and archive names; each is checked as text.
const workflow = readFileSync(
  new URL('../.github/workflows/flint-cli-release.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')

test('the workflow builds exactly the targets the manifests reference', () => {
  const built = [...workflow.matchAll(/^\s+target: (\S+)$/gm)].map((m) => m[1]).sort()
  const rendered = Object.values(TARGETS).map((t) => t.target).sort()
  assert.deepEqual(built, rendered)
})

test('archive extensions in the workflow match the renderer', () => {
  for (const { target, ext } of Object.values(TARGETS)) {
    const block = workflow.match(new RegExp(`target: ${target}\\n\\s+ext: (\\S+)`))
    assert.ok(block, `no matrix entry for ${target}`)
    assert.equal(block[1], ext, target)
  }
})

test('prereleases are not packaged and the tag is validated', () => {
  assert.match(workflow, /!github\.event\.release\.prerelease/)
  assert.match(workflow, /\^v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$/)
})

test('only the publish and registries jobs may write', () => {
  const writers = [...workflow.matchAll(/^  ([\w-]+):\n(?:(?!^  \w).*\n)*?\s+contents: write/gm)].map(
    (m) => m[1],
  )
  assert.deepEqual(writers, ['publish', 'registries'])
})
