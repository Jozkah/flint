/**
 * Agent-harness feature registry: schema, invariants and markdown rendering.
 *
 * `docs/agent-harness-features.json` is the source of truth for the 200-item
 * harness backlog; `docs/AGENT_HARNESS_FEATURE_REGISTRY.md` is rendered from it
 * and must never be hand-edited. Both the validator and the renderer share this
 * module so drift between them is impossible.
 *
 * Deliberately dependency-free: it runs on a bare `node` before `yarn install`,
 * which is what lets it gate the registry in CI and in a pre-commit hook.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATUSES = [
  'missing',
  'planned',
  'in-progress',
  'implemented',
  'verified',
  'platform-blocked',
  'rejected-with-decision',
]

/** Statuses that must carry a written reason rather than just a label. */
export const NEEDS_REASON = new Set(['platform-blocked', 'rejected-with-decision'])

/**
 * Statuses a `blockedReason` may appear on.
 *
 * The two blocked statuses require one. `in-progress` is allowed one because
 * that is where the field earns its keep in practice: it records what an item
 * still lacks, which is the difference between "partially done" and a status
 * that says nothing. Every other status forbids it -- a reason on a `verified`
 * or `missing` item is a leftover, and a leftover reason is worse than none.
 */
export const MAY_HAVE_REASON = new Set([...NEEDS_REASON, 'in-progress'])

export const SECURITY_IMPACTS = ['none', 'low', 'medium', 'high', 'critical']

/** The backlog is fixed: items may change status, never disappear.
 *
 * It grew from 200 to 205 when work the operator asked for turned out to have no
 * registry item at all -- the in-chat activity timeline, expandable project
 * navigation, side-by-side chat, the global permission centre and the cross-run
 * audit export (AH-201..AH-205) -- and again from 205 to 210 for expandable
 * project navigation, agent forking and project-scoped work (AH-206..AH-210).
 * Adding items is allowed and removing them is not: the count is a floor that
 * this constant records, so a deletion still fails validation.
 */
export const EXPECTED_FEATURE_COUNT = 211

/** Inclusive id ranges per delivery phase, in dependency order. */
export const PHASES = [
  { phase: 0, name: 'Foundation', from: 1, to: 12 },
  { phase: 1, name: 'Core execution', from: 13, to: 32 },
  { phase: 2, name: 'Security and permissions', from: 33, to: 52 },
  { phase: 3, name: 'Repository intelligence', from: 53, to: 72 },
  { phase: 4, name: 'Context and memory', from: 73, to: 88 },
  { phase: 5, name: 'Agent orchestration', from: 89, to: 113 },
  { phase: 6, name: 'Compatibility and integrations', from: 114, to: 145 },
  { phase: 7, name: 'Coding and Git workflows', from: 146, to: 171 },
  { phase: 8, name: 'UX, automation and operations', from: 172, to: 200 },
  // AH-201..AH-211 are their own phase rather than an extension of phase 8:
  // they were approved after the original 200 were planned, and folding them
  // into phase 8 would misreport when they were decided.
  { phase: 9, name: 'Approved additions', from: 201, to: 211 },
]

export const LANES = [
  'lane-01-architecture-registry',
  'lane-02-execution-runtime',
  'lane-03-permission-security',
  'lane-04-repo-index-lsp',
  'lane-05-context-memory',
  'lane-06-agents-worktrees',
  'lane-07-mcp-skills-plugins',
  'lane-08-git-pr-workflows',
  'lane-09-ux-observability',
  'lane-10-provider-enterprise',
  'lane-12-security-regression-review',
  // Opened with AH-201..AH-210, after the original ten lanes were drawn.
  'lane-21-sessions',
  'lane-22-checkpoints',
  'lane-23-composer',
  'lane-24-navigation',
  'lane-25-agents',
  'lane-26-projects',
]

const REQUIRED_FIELDS = {
  id: 'string',
  title: 'string',
  category: 'string',
  status: 'string',
  priority: 'string',
  owner: 'string',
  securityImpact: 'string',
  phase: 'number',
  phaseName: 'string',
  dependencies: 'array',
  files: 'array',
  acceptanceCriteria: 'array',
  tests: 'array',
  platformRequirements: 'array',
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : typeof v)

export const featureNumber = (id) => Number.parseInt(id.slice(3), 10)

export const phaseForId = (id) => {
  const n = featureNumber(id)
  return PHASES.find((p) => n >= p.from && n <= p.to)
}

export function loadRegistry(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Returns a list of human-readable problems. Empty means the registry holds.
 * Every check states what is wrong and which id it is wrong on, because these
 * messages are the whole CI failure output.
 */
export function validateRegistry(doc) {
  const problems = []
  const bad = (msg) => problems.push(msg)

  if (typeof doc?.schemaVersion !== 'number') bad('schemaVersion must be a number')
  if (!Array.isArray(doc?.features)) {
    bad('features must be an array')
    return problems
  }

  const vocabulary = doc.statusVocabulary
  if (!Array.isArray(vocabulary) || vocabulary.join(',') !== STATUSES.join(',')) {
    bad(`statusVocabulary must be exactly [${STATUSES.join(', ')}]`)
  }
  for (const status of STATUSES) {
    if (typeof doc.statusMeaning?.[status] !== 'string') {
      bad(`statusMeaning is missing an entry for "${status}"`)
    }
  }

  const features = doc.features
  if (features.length !== EXPECTED_FEATURE_COUNT) {
    bad(
      `expected ${EXPECTED_FEATURE_COUNT} features, found ${features.length}. ` +
        'Backlog items must not be deleted or merged; change status instead.'
    )
  }

  const seen = new Set()
  for (const [index, feature] of features.entries()) {
    const id = typeof feature?.id === 'string' ? feature.id : `#${index}`

    for (const [field, expected] of Object.entries(REQUIRED_FIELDS)) {
      if (typeOf(feature?.[field]) !== expected) {
        bad(`${id}: field "${field}" must be ${expected}, got ${typeOf(feature?.[field])}`)
      }
    }
    if (!/^AH-\d{3}$/.test(feature?.id ?? '')) {
      bad(`${id}: id must match AH-000`)
      continue
    }
    if (seen.has(feature.id)) bad(`${feature.id}: duplicate id`)
    seen.add(feature.id)

    const expectedId = `AH-${String(index + 1).padStart(3, '0')}`
    if (feature.id !== expectedId) {
      bad(`${feature.id}: ids must be dense and sorted; expected ${expectedId} at position ${index}`)
    }
    if (!STATUSES.includes(feature.status)) {
      bad(`${feature.id}: unknown status "${feature.status}"`)
    }
    if (!/^P[0-3]$/.test(feature.priority ?? '')) {
      bad(`${feature.id}: priority must be P0-P3, got "${feature.priority}"`)
    }
    if (!SECURITY_IMPACTS.includes(feature.securityImpact)) {
      bad(`${feature.id}: unknown securityImpact "${feature.securityImpact}"`)
    }
    if (!LANES.includes(feature.owner)) {
      bad(`${feature.id}: owner "${feature.owner}" is not a declared lane`)
    }
    const phase = phaseForId(feature.id)
    if (!phase) {
      bad(`${feature.id}: id falls outside every declared phase range`)
    } else if (feature.phase !== phase.phase || feature.phaseName !== phase.name) {
      bad(`${feature.id}: belongs to phase ${phase.phase} (${phase.name})`)
    }
    if ((feature.acceptanceCriteria ?? []).length === 0) {
      bad(`${feature.id}: needs at least one acceptance criterion`)
    }

    const hasReason = typeof feature.blockedReason === 'string' && feature.blockedReason.trim() !== ''
    if (NEEDS_REASON.has(feature.status) && !hasReason) {
      bad(`${feature.id}: status "${feature.status}" requires a written blockedReason`)
    }
    if (!MAY_HAVE_REASON.has(feature.status) && hasReason) {
      bad(
        `${feature.id}: blockedReason is only meaningful for ` +
          `${[...MAY_HAVE_REASON].join(', ')}`
      )
    }
    if (['implemented', 'verified'].includes(feature.status) && (feature.files ?? []).length === 0) {
      bad(`${feature.id}: status "${feature.status}" requires the implementing files to be listed`)
    }
    if (feature.status === 'verified' && (feature.tests ?? []).length === 0) {
      bad(`${feature.id}: "verified" requires the tests that verify it to be listed`)
    }
  }

  for (const feature of features) {
    for (const dep of feature.dependencies ?? []) {
      if (dep === feature.id) bad(`${feature.id}: depends on itself`)
      else if (!seen.has(dep)) bad(`${feature.id}: depends on unknown feature ${dep}`)
    }
  }
  for (const cycle of findCycles(features)) {
    bad(`dependency cycle: ${cycle.join(' -> ')}`)
  }

  return problems
}

/**
 * Lists `implemented` and `verified` items whose listed files are not on disk.
 *
 * Kept apart from `validateRegistry`, which stays a pure check of the document:
 * this one reads the working tree, relative to `root`. It exists because six
 * items once kept claiming a crate that a merge had dropped, and nothing
 * noticed. Unfinished items are exempt -- their files may name work to come.
 */
export function findMissingFiles(doc, root) {
  const problems = []
  for (const feature of doc?.features ?? []) {
    if (!['implemented', 'verified'].includes(feature?.status)) continue
    for (const file of feature.files ?? []) {
      if (!existsSync(join(root, file))) {
        problems.push(`${feature.id}: status "${feature.status}" lists ${file}, which does not exist`)
      }
    }
  }
  return problems
}

/** Depth-first cycle search over the dependency edges. */
export function findCycles(features) {
  const edges = new Map(features.map((f) => [f.id, (f.dependencies ?? []).filter((d) => d !== f.id)]))
  const state = new Map()
  const cycles = []
  const stack = []

  const walk = (id) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'open') {
      cycles.push([...stack.slice(stack.indexOf(id)), id])
      return
    }
    if (!edges.has(id)) return
    state.set(id, 'open')
    stack.push(id)
    for (const next of edges.get(id)) walk(next)
    stack.pop()
    state.set(id, 'done')
  }

  for (const id of edges.keys()) walk(id)
  return cycles
}

const countByStatus = (features) =>
  Object.fromEntries(STATUSES.map((s) => [s, features.filter((f) => f.status === s).length]))

export function renderMarkdown(doc) {
  const features = [...doc.features].sort((a, b) => a.id.localeCompare(b.id))
  const out = []

  out.push('# Agent harness feature registry\n')
  out.push('Generated from `docs/agent-harness-features.json`, which is the source of truth.')
  out.push('Run `node scripts/agent-harness/validate-registry.mjs` after any edit: it enforces the')
  out.push('schema, the status vocabulary, dependency integrity and this file staying in sync.')
  out.push('Regenerate with `node scripts/agent-harness/render-registry.mjs`; never hand-edit it.\n')

  out.push('## Status vocabulary\n')
  out.push('| Status | Meaning |')
  out.push('| --- | --- |')
  for (const status of STATUSES) out.push(`| \`${status}\` | ${doc.statusMeaning[status]} |`)
  out.push('')
  out.push('No backlog item may be deleted, merged, renumbered or silently downgraded. An item')
  out.push('leaves the backlog only as `verified`, `platform-blocked` or `rejected-with-decision`,')
  out.push('and the latter two require a recorded `blockedReason`.\n')

  out.push('## Totals by phase\n')
  out.push(`| Phase | Name | ${STATUSES.map((s) => `\`${s}\``).join(' | ')} | Total |`)
  out.push(`| --- | --- | ${STATUSES.map(() => '---').join(' | ')} | --- |`)
  for (const { phase, name } of PHASES) {
    const rows = features.filter((f) => f.phase === phase)
    const counts = countByStatus(rows)
    out.push(`| ${phase} | ${name} | ${STATUSES.map((s) => counts[s]).join(' | ')} | ${rows.length} |`)
  }
  const totals = countByStatus(features)
  out.push(`| **all** | | ${STATUSES.map((s) => `**${totals[s]}**`).join(' | ')} | **${features.length}** |`)
  out.push('')

  out.push('## Ownership lanes\n')
  out.push('Each lane owns its files exclusively. Two lanes never edit the same module in the same')
  out.push('phase; where a change crosses a boundary the owning lane makes it and the other lane')
  out.push('consumes the result.\n')
  out.push('| Lane | Features |')
  out.push('| --- | --- |')
  for (const lane of LANES) {
    const owned = features.filter((f) => f.owner === lane).map((f) => f.id)
    if (owned.length === 0) continue
    out.push(`| \`${lane}\` | ${owned.length} (${owned[0]}-${owned[owned.length - 1]}) |`)
  }
  out.push('')
  out.push('`lane-11-cross-platform-verification` owns `docs/AGENT_HARNESS_VERIFICATION.md` and the')
  out.push('per-OS evidence log rather than backlog items.\n')

  out.push('## Features\n')
  out.push('| ID | Title | Phase | Category | Priority | Status | Security | Depends on |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const f of features) {
    const deps = f.dependencies.map((d) => `\`${d}\``).join(', ') || '-'
    out.push(
      `| \`${f.id}\` | ${f.title} | ${f.phase} | ${f.category} | ${f.priority} | ` +
        `\`${f.status}\` | ${f.securityImpact} | ${deps} |`
    )
  }
  out.push('')

  out.push('## Audit notes\n')
  out.push('Recorded during the Phase 0 audit of `main`. Each note says why an item is not already')
  out.push('`implemented`, so later phases start from evidence rather than a re-audit.\n')
  for (const f of features) {
    if (f.auditNote) out.push(`- **\`${f.id}\` ${f.title}** - ${f.auditNote}`)
  }
  out.push('')

  return out.join('\n')
}
