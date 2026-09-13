#!/usr/bin/env node
/**
 * Gate for the agent-harness feature registry.
 *
 * Fails when the JSON breaks its schema or invariants, or when the rendered
 * markdown has drifted from it. Dependency-free, so CI can run it with a bare
 * `node` before any install step.
 */
import { readFileSync } from 'node:fs'
import { findMissingFiles, loadRegistry, renderMarkdown, validateRegistry } from './registry.mjs'
import { JSON_PATH, MARKDOWN_PATH, REPO_ROOT } from './paths.mjs'

const problems = []

let doc
try {
  doc = loadRegistry(JSON_PATH)
} catch (error) {
  console.error(`Could not read ${JSON_PATH}: ${error.message}`)
  process.exit(1)
}

problems.push(...validateRegistry(doc))
problems.push(...findMissingFiles(doc, REPO_ROOT))

if (problems.length === 0) {
  let current
  try {
    current = readFileSync(MARKDOWN_PATH, 'utf8')
  } catch (error) {
    problems.push(`Could not read ${MARKDOWN_PATH}: ${error.message}`)
  }
  if (current !== undefined && current !== renderMarkdown(doc)) {
    problems.push(
      'docs/AGENT_HARNESS_FEATURE_REGISTRY.md is out of date. ' +
        'Run: node scripts/agent-harness/render-registry.mjs'
    )
  }
}

if (problems.length > 0) {
  console.error(`Feature registry invalid (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const byStatus = new Map()
for (const feature of doc.features) {
  byStatus.set(feature.status, (byStatus.get(feature.status) ?? 0) + 1)
}
const summary = doc.statusVocabulary
  .filter((status) => byStatus.has(status))
  .map((status) => `${status}=${byStatus.get(status)}`)
  .join(' ')
console.log(`Feature registry OK: ${doc.features.length} features (${summary})`)
