import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CoworkTurn } from '@/types/coworkSession'
import type { InFlightRecord } from '@/lib/coworkInflight'

const h = vi.hoisted(() => ({
  inFlight: undefined as InFlightRecord | undefined,
  liveRunId: undefined as string | undefined,
  recover: vi.fn((_id: string, _choice: string) => true),
}))

vi.mock('@/hooks/useCoworkSessions', () => {
  const state = () => ({
    sessions: [{ id: 's1', inFlight: h.inFlight }],
    recoverInFlight: h.recover,
  })
  const useCoworkSessions = ((selector: (s: any) => unknown) => selector(state())) as any
  useCoworkSessions.getState = state
  return { useCoworkSessions }
})
vi.mock('@/hooks/useCoworkRun', () => ({
  useCoworkRun: (selector: (s: any) => unknown) =>
    selector({ runs: h.liveRunId ? { s1: { runId: h.liveRunId } } : {} }),
}))
vi.mock('@/i18n/react-i18next-compat', async () => {
  const i18n = (await import('@/i18n/setup')).default
  return { useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => i18n.t(k, o) }) }
})

import { CoworkInterruptedTurn } from '@/containers/CoworkInterruptedTurn'

const turns = (withPartial: boolean): CoworkTurn[] => [
  { role: 'user', content: 'fix it' },
  { role: 'tool', content: '', callId: 'c1', name: 'read', status: 'done', result: 'body' } as CoworkTurn,
  ...(withPartial ? [{ role: 'assistant', content: 'I will now ' } as CoworkTurn] : []),
]

const record = (withPartial = true): InFlightRecord => ({
  runId: 'run-dead',
  startedAt: 1,
  checkpointAt: 2,
  baseCount: 0,
  turns: turns(withPartial),
})

beforeEach(() => {
  h.inFlight = undefined
  h.liveRunId = undefined
  h.recover.mockClear()
})

describe('CoworkInterruptedTurn (AH-026)', () => {
  it('shows nothing when no turn was left in flight', () => {
    render(<CoworkInterruptedTurn sessionId="s1" running={false} onContinue={() => {}} />)
    expect(screen.queryByTestId('cowork-interrupted-turn')).toBeNull()
  })

  it('shows nothing while the run that owns the checkpoint is still running here', () => {
    h.inFlight = record()
    h.liveRunId = 'run-dead'
    render(<CoworkInterruptedTurn sessionId="s1" running onContinue={() => {}} />)
    expect(screen.queryByTestId('cowork-interrupted-turn')).toBeNull()
  })

  it('offers both choices for an unfinished reply, and continues only when asked', () => {
    h.inFlight = record()
    const onContinue = vi.fn()
    render(<CoworkInterruptedTurn sessionId="s1" running={false} onContinue={onContinue} />)
    const banner = screen.getByTestId('cowork-interrupted-turn')
    expect(banner.dataset.calls).toBe('1')
    expect(banner.dataset.partialChars).toBe(String('I will now '.length))
    expect(banner.textContent).toContain('1 completed step kept')
    expect(onContinue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('cowork-interrupted-continue'))
    expect(h.recover).toHaveBeenCalledWith('s1', 'continue')
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('discards the unfinished reply when that is chosen', () => {
    h.inFlight = record()
    const onContinue = vi.fn()
    render(<CoworkInterruptedTurn sessionId="s1" running={false} onContinue={onContinue} />)
    fireEvent.click(screen.getByTestId('cowork-interrupted-discard'))
    expect(h.recover).toHaveBeenCalledWith('s1', 'discard-partial')
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('has no discard choice when there was no unfinished reply', () => {
    h.inFlight = record(false)
    render(<CoworkInterruptedTurn sessionId="s1" running={false} onContinue={() => {}} />)
    expect(screen.queryByTestId('cowork-interrupted-discard')).toBeNull()
    expect(screen.getByTestId('cowork-interrupted-turn').textContent).toContain('completed step kept')
  })

  it('does not continue when the recovery could not be taken', () => {
    h.inFlight = record()
    h.recover.mockReturnValueOnce(false)
    const onContinue = vi.fn()
    render(<CoworkInterruptedTurn sessionId="s1" running={false} onContinue={onContinue} />)
    fireEvent.click(screen.getByTestId('cowork-interrupted-continue'))
    expect(onContinue).not.toHaveBeenCalled()
  })
})
