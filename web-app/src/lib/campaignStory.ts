/**
 * The story of a campaign task, told from what was recorded: the session's
 * tool activity (files read and written, commands run, in order), the
 * campaign's event log (when it ran) and the diff (what it changed). Pure
 * formatting; nothing here calls the backend, and every input may be absent.
 */
import type { Campaign, CampaignTask } from '@/lib/campaignModel'
import type { ToolActivityItem } from '@/lib/toolActivity'
import { dotOf, wordOf } from '@/lib/campaignView'

// ---------------------------------------------------------------------------
// Steps: what the agent did, in order
// ---------------------------------------------------------------------------

export type StepKind = 'read' | 'search' | 'write' | 'command'

export type Step = {
  kind: StepKind
  /** The file, pattern or command, as the activity record names it. */
  label: string
  ok: boolean
  /** Failed calls only: the tail of what the tool said. */
  error?: string
  exitCode?: number | null
}

const KIND_OF_TOOL: Record<string, StepKind> = {
  read: 'read',
  ls: 'read',
  find: 'search',
  grep: 'search',
  write: 'write',
  edit: 'write',
  bash: 'command',
}

const FAILED_PHASES = new Set(['failed', 'timed-out', 'refused'])

const tail = (text: string, max: number) => {
  const t = text.trim()
  return t.length <= max ? t : `…${t.slice(t.length - max)}`
}

/** The recorded calls that matter to a person, oldest first. */
export function stepsOf(items: readonly ToolActivityItem[] | undefined): Step[] {
  const ordered = [...(items ?? [])].sort(
    (a, b) =>
      (a.requested_at_ms ?? a.seq ?? 0) - (b.requested_at_ms ?? b.seq ?? 0)
  )
  const out: Step[] = []
  for (const item of ordered) {
    const kind = KIND_OF_TOOL[item.tool]
    if (!kind) continue
    const failed =
      FAILED_PHASES.has(item.phase) ||
      (item.exit_code != null && item.exit_code !== 0)
    const ended = item.phase === 'succeeded' || failed
    // A call that never finished says nothing yet.
    if (!ended) continue
    out.push({
      kind,
      label: (item.summary || item.resource || item.tool).trim(),
      ok: !failed,
      ...(failed
        ? {
            error: tail(item.output || item.detail || '', 800) || undefined,
            exitCode: item.exit_code,
          }
        : {}),
    })
  }
  return out
}

export type StepGroup = {
  kind: StepKind
  steps: Step[]
  ok: boolean
}

/** Runs of the same kind fold to one line ("Read 5 files"); failures stay alone. */
export function groupSteps(steps: readonly Step[]): StepGroup[] {
  const groups: StepGroup[] = []
  for (const step of steps) {
    const last = groups[groups.length - 1]
    if (last && last.kind === step.kind && last.ok && step.ok) {
      last.steps.push(step)
    } else {
      groups.push({ kind: step.kind, steps: [step], ok: step.ok })
    }
  }
  return groups
}

export const failuresOf = (steps: readonly Step[]): number =>
  steps.filter((s) => !s.ok).length

/** The last failed call: the real error to show. */
export function lastFailure(steps: readonly Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) if (!steps[i].ok) return steps[i]
  return undefined
}

// ---------------------------------------------------------------------------
// Headline: one sentence of what happened
// ---------------------------------------------------------------------------

export type HeadlineKind =
  | 'wrote'
  | 'wroteStopped'
  | 'stoppedFailing'
  | 'stoppedPlain'
  | 'finishedNoFiles'
  | 'working'
  | 'starting'
  | 'conflict'
  | 'waiting'
  | 'queued'
  | 'needsInput'
  | 'needsApproval'
  | 'skipped'

export type StoryHeadline = {
  kind: HeadlineKind
  params: {
    count: number
    added: number
    removed: number
    failures: number
    steps: number
    tasks: string
    counted: boolean
  }
}

export type StoryInput = {
  /** Files changed; from the diff when it is known, else the recorded list. */
  files: number
  added: number
  removed: number
  /** The line counts are real (git answered), not just file names. */
  counted: boolean
  steps: readonly Step[]
}

export function headlineOf(
  task: Pick<CampaignTask, 'status' | 'dependsOn'>,
  all: readonly Pick<CampaignTask, 'id' | 'status' | 'title'>[],
  story: StoryInput
): StoryHeadline {
  const { word, waitingFor } = wordOf(task, all)
  const failures = failuresOf(story.steps)
  const make = (kind: HeadlineKind): StoryHeadline => ({
    kind,
    params: {
      count: story.files,
      added: story.added,
      removed: story.removed,
      failures,
      steps: story.steps.length,
      tasks: waitingFor.join(', '),
      counted: story.counted,
    },
  })
  switch (word) {
    case 'waiting':
      return make('waiting')
    case 'queued':
      return make('queued')
    case 'skipped':
      return make('skipped')
    case 'needsInput':
      return make('needsInput')
    case 'needsApproval':
      return make('needsApproval')
    case 'conflict':
      return make('conflict')
    case 'writing':
      return make(story.steps.length > 0 ? 'working' : 'starting')
    case 'failed':
      if (story.files > 0) return make('wroteStopped')
      return make(failures > 0 ? 'stoppedFailing' : 'stoppedPlain')
    default:
      // checking, ready, merged
      return make(story.files > 0 ? 'wrote' : 'finishedNoFiles')
  }
}

// ---------------------------------------------------------------------------
// What to do about a stuck task
// ---------------------------------------------------------------------------

export type NextStep = 'retry' | 'conflict' | 'open' | 'answer' | 'approve'

/** The one action worth recommending, or null when nothing is stuck. */
export function nextStepOf(
  task: Pick<CampaignTask, 'status' | 'attempt'>,
  canRetry: boolean
): NextStep | null {
  switch (task.status) {
    case 'awaiting_input':
      return 'answer'
    case 'awaiting_approval':
      return 'approve'
    case 'conflict':
      return 'conflict'
    case 'failed':
      return canRetry ? 'retry' : 'open'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export type CampaignEvent = {
  ts: string
  kind: string
  task?: string | null
  detail: string
}

/**
 * How long a task worked: from the first time it was running to the last
 * status change after that (or `now` while it still runs). Null when the log
 * never saw it run.
 */
export function taskDurationMs(
  events: readonly CampaignEvent[] | undefined,
  taskId: string,
  running: boolean,
  now: number
): number | null {
  const own = (events ?? []).filter(
    (e) => e.kind === 'task-status' && e.task === taskId
  )
  const startedAt = own.find((e) => /->\s*Running\b/i.test(e.detail))
  if (!startedAt) return null
  const start = Date.parse(startedAt.ts)
  if (Number.isNaN(start)) return null
  if (running) return Math.max(0, now - start)
  const last = own[own.length - 1]
  const end = Date.parse(last.ts)
  if (Number.isNaN(end) || end < start) return null
  return end - start
}

/** "45 s", "3 min", "1 h 05 min": short and plain. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${Math.max(1, s)} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}

/** Created to last update (or now while it runs). */
export function campaignElapsedMs(
  c: Pick<Campaign, 'createdAt' | 'updatedAt' | 'status'>,
  now: number
): number | null {
  const start = Date.parse(c.createdAt)
  if (Number.isNaN(start)) return null
  const live = !['done', 'failed', 'cancelled'].includes(c.status)
  const end = live ? now : Date.parse(c.updatedAt)
  if (Number.isNaN(end) || end < start) return null
  return end - start
}

// ---------------------------------------------------------------------------
// Effort and plan map
// ---------------------------------------------------------------------------

/**
 * Overall progress 0-100 that moves while tasks run, not only when one is
 * merged: a merged task counts fully, one being checked most of the way, one
 * working a bit.
 */
export function effortPercent(
  tasks: readonly Pick<CampaignTask, 'id' | 'status' | 'dependsOn'>[]
): number {
  if (tasks.length === 0) return 0
  const weight = (t: Pick<CampaignTask, 'id' | 'status' | 'dependsOn'>) => {
    switch (dotOf(t, tasks)) {
      case 'merged':
      case 'cancelled':
        return 1
      case 'verified':
        return 0.9
      case 'verifying':
        return 0.75
      case 'running':
      case 'needs-you':
        return 0.35
      default:
        return 0
    }
  }
  const sum = tasks.reduce((n, t) => n + weight(t), 0)
  return Math.round((sum / tasks.length) * 100)
}

export type PlanLevel = {
  level: number
  tasks: { id: string; title: string; waitsFor: string[] }[]
}

/** Tasks in layers: a task sits one layer below the deepest task it waits for. */
export function planLevels(
  tasks: readonly Pick<CampaignTask, 'id' | 'title' | 'dependsOn'>[]
): PlanLevel[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    // A cycle cannot be planned; the loop's back edge counts as no dependency.
    if (visiting.has(id)) return 0
    visiting.add(id)
    const t = byId.get(id)
    const d = t
      ? t.dependsOn
          .filter((x) => byId.has(x))
          .reduce((m, x) => Math.max(m, depthOf(x) + 1), 0)
      : 0
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  const levels = new Map<number, PlanLevel>()
  for (const t of tasks) {
    const d = depthOf(t.id)
    const entry = levels.get(d) ?? { level: d, tasks: [] }
    entry.tasks.push({
      id: t.id,
      title: t.title,
      waitsFor: t.dependsOn
        .map((x) => byId.get(x)?.title)
        .filter((x): x is string => !!x),
    })
    levels.set(d, entry)
  }
  return [...levels.values()].sort((a, b) => a.level - b.level)
}

/** A brief cut to a short paragraph for the card. */
export function shortBrief(brief: string, max = 280): string {
  const t = brief.trim().replace(/\s+/g, ' ')
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`
}
