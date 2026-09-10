/**
 * Build (or refresh) docs/upstream-issues-prs.json from the cached GitHub
 * payloads under .upstream-cache/.
 *
 * The queue is a durable work ledger: triage decisions already recorded in the
 * file survive a rebuild, only the upstream-owned metadata is refreshed. Run
 * scripts/upstream-intake/fetch.sh first to refresh the cache.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConcatJson } from './parse-concat-json.mjs'
import { classify, labelNames } from './classify.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const cacheDir = path.join(repoRoot, '.upstream-cache')
const queuePath = path.join(repoRoot, 'docs', 'upstream-issues-prs.json')

const SCHEMA_VERSION = 1
const SOURCE = 'janhq/jan'

// Fields the triage owns. A rebuild never clobbers these.
const OWNED = [
  'forkReproduction',
  'decision',
  'decisionReason',
  'implementationStatus',
  'forkCommits',
  'tests',
  'verification',
  'blockers',
  'registryIds',
  'notes',
]

function loadCache() {
  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))
  const issues = []
  const pulls = []
  for (const f of files) {
    const rows = readConcatJson(path.join(cacheDir, f))
    if (f.startsWith('pulls-')) pulls.push(...rows)
    else if (f.startsWith('issues-')) issues.push(...rows)
  }
  return { issues, pulls }
}

function dedupeByNumber(rows) {
  const map = new Map()
  for (const r of rows) {
    if (!r || typeof r.number !== 'number') continue
    const prev = map.get(r.number)
    if (!prev || new Date(r.updated_at) >= new Date(prev.updated_at)) map.set(r.number, r)
  }
  return map
}

function linkedRefs(body) {
  if (!body) return []
  const out = new Set()
  for (const m of body.matchAll(/(?:^|\s)#(\d{3,6})\b/g)) out.add(Number(m[1]))
  for (const m of body.matchAll(/janhq\/jan(?:\/(?:issues|pull))?[/#](\d{3,6})/g)) out.add(Number(m[1]))
  return [...out]
}

function build() {
  const { issues, pulls } = loadCache()
  const issueMap = dedupeByNumber(issues)
  const pullMap = dedupeByNumber(pulls)

  const previous = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : { items: [] }
  const prior = new Map((previous.items || []).map((i) => [i.number, i]))

  const numbers = new Set([...issueMap.keys(), ...pullMap.keys()])
  const items = []

  for (const number of [...numbers].sort((a, b) => a - b)) {
    const issue = issueMap.get(number)
    const pull = pullMap.get(number)
    const base = issue || pull
    if (!base) continue
    const c = classify(base)
    const kind = pull || base.pull_request ? 'pr' : 'issue'
    const carried = prior.get(number) || {}

    const record = {
      source: SOURCE,
      number,
      url: base.html_url || `https://github.com/janhq/jan/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
      title: base.title,
      kind,
      state: pull ? (pull.merged_at ? 'merged' : pull.state) : base.state,
      labels: labelNames(base),
      author: base.user?.login ?? null,
      createdAt: base.created_at ?? null,
      updatedAt: base.updated_at ?? null,
      closedAt: base.closed_at ?? null,
      mergedAt: pull?.merged_at ?? null,
      milestone: base.milestone?.title ?? null,
      assignees: (base.assignees || []).map((a) => a.login),
      reactions: base.reactions?.total_count ?? 0,
      comments: base.comments ?? 0,
      draft: pull?.draft ?? null,
      mergeCommitSha: pull?.merge_commit_sha ?? null,
      headSha: pull?.head?.sha ?? null,
      baseRef: pull?.base?.ref ?? null,
      headRepo: pull?.head?.repo?.full_name ?? null,
      linked: linkedRefs(base.body),
      affectedAreas: c.affectedAreas,
      platforms: c.platforms,
      upstreamCommits: [],
      severity: c.severity,
      priority: c.priority,
      signals: c.signals,
      securityImpact: c.securityImpact,
      privacyImpact: c.privacyImpact,
      dataLossRisk: c.dataLossRisk,
      localOnlyCompatibility: c.localOnlyCompatibility,
      // Triage-owned fields below.
      forkReproduction: carried.forkReproduction ?? null,
      registryIds: carried.registryIds ?? [],
      decision: carried.decision ?? 'untriaged',
      decisionReason: carried.decisionReason ?? null,
      implementationStatus: carried.implementationStatus ?? 'untriaged',
      forkCommits: carried.forkCommits ?? [],
      tests: carried.tests ?? [],
      verification: carried.verification ?? null,
      blockers: carried.blockers ?? [],
      notes: carried.notes ?? null,
    }
    items.push(record)
  }

  // Keep records that were triaged from a source no longer in the cache window.
  for (const [number, old] of prior) {
    if (numbers.has(number)) continue
    if (OWNED.some((f) => old[f] && (!Array.isArray(old[f]) || old[f].length))) items.push(old)
  }
  items.sort((a, b) => a.number - b.number)

  const counts = items.reduce((acc, i) => {
    acc.byKind[i.kind] = (acc.byKind[i.kind] || 0) + 1
    acc.byPriority[i.priority] = (acc.byPriority[i.priority] || 0) + 1
    acc.byStatus[i.implementationStatus] = (acc.byStatus[i.implementationStatus] || 0) + 1
    return acc
  }, { byKind: {}, byPriority: {}, byStatus: {} })

  const out = {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    mergeBase: previous.mergeBase ?? null,
    upstreamDefaultBranch: previous.upstreamDefaultBranch ?? 'main',
    statusVocabulary: [
      'untriaged',
      'not-applicable',
      'already-fixed',
      'reproduced',
      'implementation-ready',
      'in-progress',
      'fixed',
      'adapted',
      'rejected',
      'blocked',
      'cannot-reproduce',
      'needs-user-hardware',
    ],
    counts,
    items,
  }
  fs.writeFileSync(queuePath, JSON.stringify(out, null, 2) + '\n')
  return out
}

const result = build()
console.log(`queue: ${result.items.length} items`)
console.log('kind', result.counts.byKind)
console.log('priority', result.counts.byPriority)
console.log('status', result.counts.byStatus)
