/**
 * What a subagent's tool call means, in a line a person can follow.
 *
 * A transcript of `grep`, `read`, `ls` rows is unreadable: the arguments that
 * matter are paths, and a path truncated at the end loses its filename. This
 * turns a call into a verb, a subject and, for a path, a head/tail split so the
 * end of it can stay visible when the middle is ellipsised; and groups runs of
 * the same kind of call ("Read 5 files") so a long list reads as a few steps.
 *
 * Pure: no store, no clock.
 */
import type { CoworkTurn } from '@/types/coworkSession'

export type StepKind = 'read' | 'search' | 'list' | 'run' | 'edit' | 'web' | 'other'

/** Keys under `common:tasks.step`, so the words stay in the locale file. */
export type StepVerb =
  | 'read'
  | 'searched'
  | 'listed'
  | 'found'
  | 'ran'
  | 'wrote'
  | 'edited'
  | 'webSearched'
  | 'fetched'
  | 'used'

export type StepInfo = {
  kind: StepKind
  verb: StepVerb
  /** What it acted on: a path, a command, a query, or the tool's name. */
  subject: string
  /** The subject is a path, so it is shown ellipsised in the middle. */
  pathLike: boolean
  /** A second part: where a search looked. */
  scope?: string
  /** `lines 1-120`, when the call read a slice of a file. */
  range?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function rangeOf(args: Record<string, unknown>): string | undefined {
  const offset = typeof args.offset === 'number' ? args.offset : undefined
  const limit = typeof args.limit === 'number' ? args.limit : undefined
  if (offset === undefined && limit === undefined) return undefined
  const from = (offset ?? 0) + 1
  return limit !== undefined ? `${from}-${from + limit - 1}` : `${from}-`
}

/** Describe one tool call. Unknown tools are "Used <name>" with their key argument. */
export function describeStep(turn: Pick<CoworkTurn, 'name' | 'args'>): StepInfo {
  const name = turn.name ?? 'tool'
  const args = (turn.args && typeof turn.args === 'object' ? turn.args : {}) as Record<string, unknown>
  const path = str(args.path) || str(args.file_path)
  switch (name) {
    case 'read':
      return { kind: 'read', verb: 'read', subject: path, pathLike: true, range: rangeOf(args) }
    case 'ls':
      return { kind: 'list', verb: 'listed', subject: path || '.', pathLike: true }
    case 'grep':
      return {
        kind: 'search',
        verb: 'searched',
        subject: str(args.pattern),
        pathLike: false,
        ...(path ? { scope: path } : {}),
      }
    case 'find':
      return { kind: 'search', verb: 'found', subject: str(args.pattern) || str(args.name), pathLike: false, ...(path ? { scope: path } : {}) }
    case 'bash':
      return { kind: 'run', verb: 'ran', subject: str(args.command), pathLike: false }
    case 'write':
      return { kind: 'edit', verb: 'wrote', subject: path, pathLike: true }
    case 'edit':
      return { kind: 'edit', verb: 'edited', subject: path, pathLike: true }
    case 'web_search':
      return { kind: 'web', verb: 'webSearched', subject: str(args.query), pathLike: false }
    case 'web_fetch':
      return { kind: 'web', verb: 'fetched', subject: str(args.url), pathLike: false }
    default: {
      const first = ['path', 'query', 'command', 'url', 'name'].map((k) => str(args[k])).find(Boolean) ?? ''
      return { kind: 'other', verb: 'used', subject: first ? `${name} ${first}` : name, pathLike: false }
    }
  }
}

/** Kinds whose consecutive calls read better as one expandable group. */
const GROUPABLE = new Set<StepKind>(['read', 'search', 'list'])

export type TranscriptItem =
  | { type: 'text'; key: string; text: string }
  | { type: 'step'; key: string; turn: CoworkTurn; info: StepInfo }
  | {
      type: 'group'
      key: string
      kind: StepKind
      steps: { turn: CoworkTurn; info: StepInfo; key: string }[]
    }

/**
 * The transcript as it reads: assistant prose and tool steps in order, with
 * runs of the same readable kind (two or more) folded into a group. Hidden and
 * user turns are the brief's business, not the conversation's.
 */
export function transcriptItems(turns: readonly CoworkTurn[] | undefined): TranscriptItem[] {
  const out: TranscriptItem[] = []
  ;(turns ?? []).forEach((turn, i) => {
    if (turn.role === 'assistant') {
      if (turn.content.trim()) out.push({ type: 'text', key: `t${i}`, text: turn.content })
      return
    }
    if (turn.role !== 'tool') return
    const info = describeStep(turn)
    const last = out[out.length - 1]
    if (GROUPABLE.has(info.kind)) {
      if (last?.type === 'step' && last.info.kind === info.kind) {
        out[out.length - 1] = {
          type: 'group',
          key: `g${last.key}`,
          kind: info.kind,
          steps: [
            { turn: last.turn, info: last.info, key: last.key },
            { turn, info, key: `s${i}` },
          ],
        }
        return
      }
      if (last?.type === 'group' && last.kind === info.kind) {
        last.steps.push({ turn, info, key: `s${i}` })
        return
      }
    }
    out.push({ type: 'step', key: `s${i}`, turn, info })
  })
  return out
}

/** How long a call took, when it has both ends. */
export function stepDurationMs(turn: Pick<CoworkTurn, 'startedAt' | 'endedAt'>): number | undefined {
  if (turn.startedAt == null || turn.endedAt == null) return undefined
  return Math.max(0, turn.endedAt - turn.startedAt)
}

/** `420ms`, `1.4s`, `2m 05s`. */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/**
 * Split a path for middle-ellipsis: the head may be cut by CSS, the tail (the
 * filename and its folder) never is. A short path has no head to cut.
 */
export function middleSplit(text: string, tail = 28): { head: string; tail: string } {
  if (text.length <= tail) return { head: '', tail: text }
  // Keep the tail starting at a separator when there is one near the cut, so
  // the visible end begins at a folder boundary, not mid-name.
  const cut = text.length - tail
  const sep = Math.max(text.lastIndexOf('/', cut + 12), text.lastIndexOf('\\', cut + 12))
  const at = sep > 0 && sep >= cut - 12 ? sep : cut
  return { head: text.slice(0, at), tail: text.slice(at) }
}

/** What a tool turn is doing now. */
export function stepState(turn: CoworkTurn): 'active' | 'ok' | 'failed' {
  if (turn.isError || turn.toolState === 'failed' || turn.toolState === 'refused' || turn.toolState === 'timed-out') return 'failed'
  if (turn.toolState === 'cancelled' || turn.toolState === 'stale') return 'failed'
  if (turn.toolState === 'requested' || turn.toolState === 'awaiting-permission' || turn.toolState === 'running') return 'active'
  if (!turn.toolState && turn.status === 'running') return 'active'
  return 'ok'
}
