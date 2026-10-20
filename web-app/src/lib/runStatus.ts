/**
 * What a running agent is doing right now, in a few words, the way a
 * terminal agent's status line reads: "Thinking…", "Running bash…",
 * "Reading tool results…". Replaces a flat "Working…" that said nothing about
 * where the time was going.
 *
 * Long phases change wording so a slow step reads as slow rather than stuck.
 */
import type { CoworkTurn } from '@/types/coworkSession'

export type RunPhase =
  | 'waiting'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'after-tool'

export type RunStatus = {
  phase: RunPhase
  /** Changes when the phase or its subject (the tool) changes. */
  key: string
  /** Label for a phase that has lasted `elapsedMs`. */
  label: (elapsedMs: number) => string
  /** The tool call a `tool` phase is waiting on, so it can be stopped alone. */
  callId?: string
}

/** How long a tool runs before the status line offers to stop it. */
export const STOP_TOOL_AFTER_MS = 30_000

const OPEN_THINK = /<(think|thought|thinking)>/gi
const CLOSE_THINK = /<\/(think|thought|thinking)>/gi

/** Whether the text is inside an unclosed <think> block. */
export function inThinkBlock(text: string): boolean {
  const opens = text.match(OPEN_THINK)?.length ?? 0
  const closes = text.match(CLOSE_THINK)?.length ?? 0
  return opens > closes
}

/** `mcp__server__tool_name` / `web_fetch` -> `tool name` / `web fetch`. */
export function toolLabel(name: string | undefined): string {
  if (!name) return 'a tool'
  const base = name.split('__').pop() ?? name
  return base.replace(/[_-]+/g, ' ').trim() || 'a tool'
}

const S = 1000

function byAge(steps: Array<[number, string]>) {
  return (elapsed: number) => {
    let label = steps[0][1]
    for (const [after, text] of steps) if (elapsed >= after) label = text
    return label
  }
}

/** i18next-style translate; the tool lines below take it so they follow the UI language. */
export type StatusTranslate = (key: string, options: { tool: string }) => string

const ENGLISH: Record<string, (tool: string) => string> = {
  'tools:toolCall.runningStatus': (tool) => `Running ${tool}…`,
  'tools:toolCall.stillRunning': (tool) => `Still running ${tool}…`,
}

/**
 * Waiting on the model with nothing back yet: before the first token, or (with
 * `quiet`) after a reply that was flowing went silent. Chat and Cowork share it
 * so the wording and the slow-model escalation match.
 */
export function modelWaitStatus(quiet = false): RunStatus {
  return {
    phase: 'waiting',
    key: quiet ? 'waiting:quiet' : 'waiting',
    label: byAge(
      quiet
        ? [
            [0, 'Still waiting for the model…'],
            [60 * S, 'The model is taking a while…'],
          ]
        : [
            [0, 'Waiting for the model…'],
            [15 * S, 'Still waiting for the model…'],
            [60 * S, 'The model is taking a while…'],
          ]
    ),
  }
}

export function runStatus(
  running: boolean,
  turns: readonly CoworkTurn[],
  t?: StatusTranslate
): RunStatus | null {
  if (!running) return null
  const say = (key: string, tool: string) =>
    t ? t(key, { tool }) : ENGLISH[key](tool)
  const last = turns.at(-1)
  if (!last || last.role === 'user') return modelWaitStatus()
  if (last.role === 'tool') {
    if (last.status !== 'done') {
      const name = toolLabel(last.name)
      return {
        phase: 'tool',
        key: `tool:${last.callId ?? name}`,
        callId: last.callId,
        label: byAge([
          [0, say('tools:toolCall.runningStatus', name)],
          [30 * S, say('tools:toolCall.stillRunning', name)],
        ]),
      }
    }
    return {
      phase: 'after-tool',
      key: `after:${last.callId ?? ''}`,
      label: byAge([
        [0, 'Reading tool results…'],
        [10 * S, 'Waiting for the model…'],
        [45 * S, 'Still waiting for the model…'],
        [60 * S, 'The model is taking a while…'],
      ]),
    }
  }
  const text = last.content ?? ''
  if (inThinkBlock(text)) {
    return {
      phase: 'thinking',
      key: 'thinking',
      label: byAge([
        [0, 'Thinking…'],
        [20 * S, 'Still thinking…'],
        [60 * S, 'Thinking hard…'],
        [120 * S, 'Almost done thinking…'],
      ]),
    }
  }
  if (!text.replace(CLOSE_THINK, '').trim()) {
    return {
      phase: 'waiting',
      key: 'waiting',
      label: byAge([
        [0, 'Waiting for the model…'],
        [15 * S, 'Still waiting for the model…'],
      ]),
    }
  }
  return { phase: 'writing', key: 'writing', label: () => 'Writing…' }
}

/** `9s`, `1m 05s`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
