#!/usr/bin/env node
/**
 * Renders docs/AGENT_HARNESS_FEATURE_REGISTRY.md from the JSON registry.
 * The markdown is a build artefact; edit docs/agent-harness-features.json.
 */
import { writeFileSync } from 'node:fs'
import { loadRegistry, renderMarkdown, validateRegistry } from './registry.mjs'
import { JSON_PATH, MARKDOWN_PATH } from './paths.mjs'

const doc = loadRegistry(JSON_PATH)
const problems = validateRegistry(doc)
if (problems.length > 0) {
  console.error('Refusing to render an invalid registry:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

writeFileSync(MARKDOWN_PATH, renderMarkdown(doc))
console.log(`Rendered ${doc.features.length} features to ${MARKDOWN_PATH}`)
