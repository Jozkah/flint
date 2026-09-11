import { beforeEach, describe, expect, it } from 'vitest'
import { useCoworkRun } from '@/hooks/useCoworkRun'

/**
 * janhq/jan#8905. Every piece of a Cowork run's state belongs to the session
 * that started it, and a write from a run that is no longer that session's
 * current run is refused rather than landing on whatever is in view.
 */

const reset = () =>
  useCoworkRun.setState({
    runs: {},
    outcomes: {},
    liveTurns: {},
    usage: {},
    subagents: {},
    pendingAsks: {},
    promptSnapshots: {},
  })

describe('per-session runs', () => {
  beforeEach(reset)

  it('marks only the session that started a run as running', () => {
    useCoworkRun.getState().startRun('a', 'run-a')
    const { runs } = useCoworkRun.getState()
    expect(runs.a?.runId).toBe('run-a')
    expect(runs.b).toBeUndefined()
  })

  it('keeps two sessions running at once, each with its own run id', () => {
    useCoworkRun.getState().startRun('a', 'run-a')
    useCoworkRun.getState().startRun('b', 'run-b')
    const { runs } = useCoworkRun.getState()
    expect(runs.a?.runId).toBe('run-a')
    expect(runs.b?.runId).toBe('run-b')
  })

  it('writes live turns only for the run that owns the session', () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-a')
    store.setRunTurns('a', 'run-a', [{ role: 'user', content: 'mine' }])
    // A late write from a run the session no longer has is refused.
    store.setRunTurns('a', 'stale-run', [{ role: 'user', content: 'late' }])
    expect(useCoworkRun.getState().liveTurns.a).toEqual([
      { role: 'user', content: 'mine' },
    ])
  })

  it('refuses a write for a session that has no run', () => {
    useCoworkRun.getState().setRunTurns('b', 'run-a', [
      { role: 'user', content: 'misrouted' },
    ])
    expect(useCoworkRun.getState().liveTurns.b).toBeUndefined()
  })

  it('records an outcome for the finishing run only, and clears its live state', () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-a')
    store.setRunTurns('a', 'run-a', [{ role: 'user', content: 'q' }])
    store.finishRun('a', 'run-a', { stoppedBy: 'aborted' })
    const state = useCoworkRun.getState()
    expect(state.runs.a).toBeUndefined()
    expect(state.outcomes.a).toEqual({ stoppedBy: 'aborted' })
    expect(state.liveTurns.a).toBeUndefined()
  })

  it('does not let a superseded run finish the run that replaced it', () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-1')
    store.startRun('a', 'run-2')
    store.finishRun('a', 'run-1', { stoppedBy: 'error', errorText: 'late' })
    const state = useCoworkRun.getState()
    expect(state.runs.a?.runId).toBe('run-2')
    expect(state.outcomes.a).toBeUndefined()
  })

  it('clears the previous outcome and usage when a session starts again', () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-1')
    store.setUsage('a', { input_tokens: 1, output_tokens: 1 } as never)
    store.finishRun('a', 'run-1', { stoppedBy: 'error', errorText: 'boom' })
    store.startRun('a', 'run-2')
    const state = useCoworkRun.getState()
    expect(state.outcomes.a).toBeUndefined()
    expect(state.usage.a).toBeUndefined()
  })

  it("leaves another session's outcome alone", () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-a')
    store.startRun('b', 'run-b')
    store.finishRun('b', 'run-b', { stoppedBy: 'aborted' })
    const state = useCoworkRun.getState()
    expect(state.runs.a?.runId).toBe('run-a')
    expect(state.outcomes.a).toBeUndefined()
  })

  it('forgets everything about a deleted session', () => {
    const store = useCoworkRun.getState()
    store.startRun('a', 'run-a')
    store.setRunTurns('a', 'run-a', [{ role: 'user', content: 'q' }])
    store.addPendingAsk('a', 'ask-1', { questions: [] } as never)
    store.forgetSession('a')
    const state = useCoworkRun.getState()
    expect(state.runs.a).toBeUndefined()
    expect(state.liveTurns.a).toBeUndefined()
    expect(state.pendingAsks.a).toBeUndefined()
    // And a late write from the deleted session's run is refused.
    store.setRunTurns('a', 'run-a', [{ role: 'user', content: 'late' }])
    expect(useCoworkRun.getState().liveTurns.a).toBeUndefined()
  })
})
