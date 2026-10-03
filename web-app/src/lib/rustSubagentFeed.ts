/**
 * Subagents the Rust loop dispatched (`dispatch_subagent`), shown in the same
 * Tasks panel, Background tasks tab and transcript view as the ones Cowork runs
 * itself.
 *
 * The Rust loop reports a child as a bracket of events: `subagent_queued` /
 * `subagent_start`, the child's own events wrapped in `subagent`, then
 * `subagent_finished` (how it ended, its usage, why) and `subagent_end`. This
 * folds them into the activity record: one task per child, its transcript built
 * with the same merge the Cowork stream uses, and its usage, status and
 * step-limit stop recorded where the panels already read them. Nothing here is
 * a second store.
 *
 * Idempotent, so a feed built after the run started can be caught up with
 * `replay`: events for a child the panel has not seen are enough to create it,
 * and applying the same events again changes nothing. Every transcript is
 * bounded, and every tool result is cut, so a long-running child cannot grow
 * the record without limit.
 */
import { useCoworkActivity } from '@/hooks/useCoworkActivity'
import { applyInnerToTurns, type StreamEvent } from '@/hooks/useCoworkRun'
import { recordAgentDispatch } from '@/lib/coworkActivityRecorder'
import { taskIdFor } from '@/lib/coworkActivity'
import { tallyToolCalls } from '@/lib/coworkSubagentStats'
import { redactSecrets } from '@/lib/redact'
import type { CoworkTurn, Usage } from '@/types/coworkSession'

/** Turns kept per child. The oldest are dropped first. */
export const MAX_FEED_TURNS = 400
/** Characters kept of any one tool result or message. */
export const MAX_FEED_TEXT = 8_000
/** Events a host keeps for catching a late panel up. */
export const MAX_FEED_LOG = 4_000

export type FeedContext = {
  sessionId: string
  /** The run the children belong to (the workflow the rows hang under). */
  runId: string
  model?: string
}

const cut = (text: string): string =>
  text.length > MAX_FEED_TEXT
    ? `${text.slice(0, MAX_FEED_TEXT)}\n[... ${text.length - MAX_FEED_TEXT} more characters not kept ...]`
    : text

/** A turn as it is stored: bounded, with secrets redacted. */
function bound(turn: CoworkTurn): CoworkTurn {
  return {
    ...turn,
    content: cut(redactSecrets(turn.content)),
    ...(turn.result !== undefined ? { result: cut(redactSecrets(turn.result)) } : {}),
  }
}

export class RustSubagentFeed {
  private readonly turns = new Map<string, CoworkTurn[]>()
  private readonly log: StreamEvent[] = []

  constructor(private readonly ctx: FeedContext) {}

  private id(runId: string): string {
    return taskIdFor(this.ctx.sessionId, this.ctx.runId, runId)
  }

  /** Titles that arrived before their row existed. */
  private readonly titles = new Map<string, string>()

  private ensure(runId: string, name: string, task?: string) {
    const store = useCoworkActivity.getState()
    if (store.tasks[this.id(runId)]) return
    recordAgentDispatch(
      { sessionId: this.ctx.sessionId, runId: this.ctx.runId } as never,
      {
        callId: runId,
        agentName: name,
        title: this.titles.get(runId),
        description: task ? redactSecrets(task) : undefined,
        model: this.ctx.model,
        background: true,
      }
    )
  }

  /** The events seen so far, bounded, for `replay` into a later feed. */
  events(): readonly StreamEvent[] {
    return this.log
  }

  /** Catch up on events that happened before this feed was attached. */
  replay(events: readonly StreamEvent[]): void {
    for (const ev of events) this.apply(ev)
  }

  apply(ev: StreamEvent): void {
    this.log.push(ev)
    if (this.log.length > MAX_FEED_LOG) this.log.splice(0, this.log.length - MAX_FEED_LOG)
    const store = useCoworkActivity.getState()
    switch (ev.type) {
      case 'subagent_title': {
        const title = redactSecrets(ev.title).trim()
        if (!title) return
        this.titles.set(ev.run_id, title)
        if (store.tasks[this.id(ev.run_id)]) store.patchTask(this.id(ev.run_id), { title })
        return
      }
      case 'subagent_queued': {
        this.ensure(ev.run_id, ev.name)
        store.patchTask(this.id(ev.run_id), { status: 'queued', waiting: ev.waiting })
        return
      }
      case 'subagent_start': {
        this.ensure(ev.run_id, ev.name, ev.task)
        const existing = store.tasks[this.id(ev.run_id)]
        store.patchTask(this.id(ev.run_id), {
          status: 'running',
          waiting: undefined,
          ...(ev.task && !existing?.description
            ? { description: redactSecrets(ev.task) }
            : {}),
        })
        return
      }
      case 'subagent': {
        this.ensure(ev.run_id, ev.name)
        const next = applyInnerToTurns(this.turns.get(ev.run_id) ?? [], ev.event)
        const bounded = next.slice(-MAX_FEED_TURNS).map(bound)
        this.turns.set(ev.run_id, bounded)
        store.patchTask(this.id(ev.run_id), {
          transcript: bounded,
          toolCount: tallyToolCalls(bounded).total,
        })
        return
      }
      case 'subagent_finished': {
        this.ensure(ev.run_id, ev.name)
        const usage = ev.usage ? normalizeUsage(ev.usage) : undefined
        const status =
          ev.status === 'done' ? ('done' as const) : ('error' as const)
        store.patchTask(this.id(ev.run_id), {
          status,
          endedAt: Date.now(),
          ...(usage ? { usage } : {}),
          ...(ev.status === 'turn_limit' ? { stoppedAtLimit: true } : {}),
          ...(ev.detail ? { detail: redactSecrets(ev.detail) } : {}),
        })
        return
      }
      case 'subagent_end': {
        // An older emitter sends no `subagent_finished`; settle what is still
        // open as done. A finished task keeps the status it has.
        const task = store.tasks[this.id(ev.run_id)]
        if (task && (task.status === 'running' || task.status === 'queued')) {
          store.patchTask(this.id(ev.run_id), {
            status: 'done',
            endedAt: Date.now(),
            ...(ev.usage ? { usage: normalizeUsage(ev.usage) } : {}),
          })
        }
        return
      }
      default:
        return
    }
  }
}

/** Rust usage objects use the same snake_case names; keep only the numbers. */
function normalizeUsage(raw: unknown): Usage {
  const r = (raw ?? {}) as Record<string, unknown>
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : undefined)
  const prompt = n('prompt_tokens') ?? n('input_tokens')
  const completion = n('completion_tokens') ?? n('output_tokens')
  const total = n('total_tokens') ?? (prompt ?? 0) + (completion ?? 0)
  return {
    ...(prompt !== undefined ? { prompt_tokens: prompt } : {}),
    ...(completion !== undefined ? { completion_tokens: completion } : {}),
    total_tokens: total,
  }
}
