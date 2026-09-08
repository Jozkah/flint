/**
 * Tests for the feature-registry gate.
 * Run with `node --test "scripts/agent-harness/*.test.mjs"`.
 *
 * These cover the refusal paths as well as the success path: the validator is
 * only worth having if it actually rejects a registry that has been quietly
 * damaged, which is the failure mode a 200-item backlog invites.
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED_FEATURE_COUNT,
  LANES,
  PHASES,
  findCycles,
  loadRegistry,
  phaseForId,
  renderMarkdown,
  validateRegistry,
} from './registry.mjs'
import { JSON_PATH, MARKDOWN_PATH } from './paths.mjs'

const pristine = () => structuredClone(loadRegistry(JSON_PATH))

/** Asserts that validation fails, and that at least one message mentions `needle`. */
const expectProblem = (doc, needle) => {
  const problems = validateRegistry(doc)
  assert.ok(problems.length > 0, 'expected the registry to be rejected')
  assert.ok(
    problems.some((problem) => problem.includes(needle)),
    `expected a problem mentioning ${JSON.stringify(needle)}, got:\n${problems.join('\n')}`
  )
}

test('the committed registry is valid', () => {
  assert.deepEqual(validateRegistry(pristine()), [])
})

test('the committed registry holds every backlog item', () => {
  assert.equal(pristine().features.length, EXPECTED_FEATURE_COUNT)
})

test('phase ranges tile the whole id space without gaps or overlap', () => {
  assert.equal(PHASES[0].from, 1)
  assert.equal(PHASES.at(-1).to, EXPECTED_FEATURE_COUNT)
  for (const [index, phase] of PHASES.slice(1).entries()) {
    assert.equal(phase.from, PHASES[index].to + 1, `phase ${phase.phase} does not follow the previous one`)
  }
  for (let n = 1; n <= EXPECTED_FEATURE_COUNT; n += 1) {
    assert.ok(phaseForId(`AH-${String(n).padStart(3, '0')}`), `AH-${n} has no phase`)
  }
})

test('every feature is owned by exactly one declared lane', () => {
  for (const feature of pristine().features) {
    assert.ok(LANES.includes(feature.owner), `${feature.id} has owner ${feature.owner}`)
  }
})

test('the rendered markdown matches the committed file', () => {
  assert.equal(readFileSync(MARKDOWN_PATH, 'utf8'), renderMarkdown(pristine()))
})

test('deleting a backlog item is rejected', () => {
  const doc = pristine()
  doc.features.pop()
  expectProblem(doc, 'must not be deleted or merged')
})

test('a duplicated id is rejected', () => {
  const doc = pristine()
  doc.features[5] = structuredClone(doc.features[4])
  expectProblem(doc, 'duplicate id')
})

test('a renumbered id is rejected', () => {
  const doc = pristine()
  doc.features[3].id = 'AH-777'
  expectProblem(doc, 'ids must be dense and sorted')
})

test('an unknown status is rejected', () => {
  const doc = pristine()
  doc.features[0].status = 'done'
  expectProblem(doc, 'unknown status')
})

test('a narrowed status vocabulary is rejected', () => {
  const doc = pristine()
  doc.statusVocabulary = doc.statusVocabulary.filter((status) => status !== 'platform-blocked')
  expectProblem(doc, 'statusVocabulary must be exactly')
})

test('an unknown priority is rejected', () => {
  const doc = pristine()
  doc.features[0].priority = 'urgent'
  expectProblem(doc, 'priority must be P0-P3')
})

test('an unknown security impact is rejected', () => {
  const doc = pristine()
  doc.features[0].securityImpact = 'scary'
  expectProblem(doc, 'unknown securityImpact')
})

test('an unknown owning lane is rejected', () => {
  const doc = pristine()
  doc.features[0].owner = 'lane-99-nobody'
  expectProblem(doc, 'is not a declared lane')
})

test('a dangling dependency is rejected', () => {
  const doc = pristine()
  doc.features[0].dependencies = ['AH-999']
  expectProblem(doc, 'depends on unknown feature AH-999')
})

test('a self dependency is rejected', () => {
  const doc = pristine()
  doc.features[0].dependencies = ['AH-001']
  expectProblem(doc, 'depends on itself')
})

test('a dependency cycle is rejected', () => {
  const doc = pristine()
  doc.features[0].dependencies = ['AH-002']
  doc.features[1].dependencies = ['AH-003']
  doc.features[2].dependencies = ['AH-001']
  expectProblem(doc, 'dependency cycle')
})

test('findCycles reports the members of the cycle', () => {
  const cycles = findCycles([
    { id: 'AH-001', dependencies: ['AH-002'] },
    { id: 'AH-002', dependencies: ['AH-001'] },
  ])
  assert.equal(cycles.length, 1)
  assert.deepEqual(new Set(cycles[0]), new Set(['AH-001', 'AH-002']))
})

test('a blocked feature without a reason is rejected', () => {
  const doc = pristine()
  doc.features[0].status = 'platform-blocked'
  expectProblem(doc, 'requires a written blockedReason')
})

test('a whitespace-only blocked reason does not count as a reason', () => {
  const doc = pristine()
  doc.features[0].status = 'rejected-with-decision'
  doc.features[0].blockedReason = '   '
  expectProblem(doc, 'requires a written blockedReason')
})

test('a reason on an unblocked feature is rejected', () => {
  const doc = pristine()
  doc.features[0].blockedReason = 'we ran out of time'
  expectProblem(doc, 'only meaningful for')
})

test('claiming "verified" without listed tests is rejected', () => {
  const doc = pristine()
  const feature = doc.features.find((f) => f.status === 'implemented')
  feature.status = 'verified'
  feature.tests = []
  expectProblem(doc, 'requires the tests that verify it')
})

test('claiming "implemented" without listed files is rejected', () => {
  const doc = pristine()
  const feature = doc.features.find((f) => f.status === 'missing')
  feature.status = 'implemented'
  expectProblem(doc, 'requires the implementing files')
})

test('a feature with no acceptance criteria is rejected', () => {
  const doc = pristine()
  doc.features[0].acceptanceCriteria = []
  expectProblem(doc, 'needs at least one acceptance criterion')
})

test('a feature filed under the wrong phase is rejected', () => {
  const doc = pristine()
  doc.features[0].phase = 8
  expectProblem(doc, 'belongs to phase 0')
})

test('a missing required field is rejected', () => {
  const doc = pristine()
  delete doc.features[0].acceptanceCriteria
  expectProblem(doc, 'must be array')
})

test('a non-array features collection is rejected without throwing', () => {
  expectProblem({ schemaVersion: 1, features: 'nope' }, 'features must be an array')
})
