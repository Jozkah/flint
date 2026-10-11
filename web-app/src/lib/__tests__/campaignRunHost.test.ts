import { describe, expect, it } from 'vitest'
import type { Campaign } from '@/lib/campaignModel'
import { sessionsNeedingHost, stalledToRequeue } from '@/lib/campaignRunHost'

const task = (id: string, status: string, sessionId?: string) =>
  ({ id, status, sessionId, dependsOn: [] }) as never

const camp = (
  id: string,
  tasks: unknown[],
  extra: Partial<Campaign> = {}
): Campaign =>
  ({ id, status: 'running', tasks, ...extra }) as unknown as Campaign

describe('sessionsNeedingHost', () => {
  const sessionIds = new Set(['s1', 's2', 's3', 's4'])
  const none = new Set<string>()

  it('returns live and queued-with-session tasks of a running campaign', () => {
    const c = camp('c', [
      task('a', 'running', 's1'),
      task('b', 'queued', 's2'),
      task('c', 'awaiting_input', 's3'),
      task('d', 'pending'),
      task('e', 'merged', 's4'),
      task('f', 'queued'),
    ])
    expect(
      sessionsNeedingHost({ campaigns: [c], sessionIds, hostedElsewhere: none })
    ).toEqual(['s1', 's2', 's3'])
  })

  it('skips server-driven, non-running and unknown sessions', () => {
    const cs = [
      camp('a', [task('t', 'running', 's1')], { driver: 'server' }),
      camp('b', [task('t', 'running', 's2')], { status: 'paused' as never }),
      camp('c', [task('t', 'running', 'gone')]),
    ]
    expect(
      sessionsNeedingHost({ campaigns: cs, sessionIds, hostedElsewhere: none })
    ).toEqual([])
  })

  it('leaves a session a visible page already hosts', () => {
    const c = camp('c', [task('a', 'running', 's1'), task('b', 'running', 's2')])
    expect(
      sessionsNeedingHost({
        campaigns: [c],
        sessionIds,
        hostedElsewhere: new Set(['s1']),
      })
    ).toEqual(['s2'])
  })
})

describe('stalledToRequeue', () => {
  const base = () => ({
    campaigns: [camp('c', [task('a', 'running', 's1')])],
    live: new Set<string>(),
    ended: () => false,
    hasReady: () => false,
    firstSeen: new Map<string, number>(),
    already: new Set<string>(),
  })

  it('waits for the grace, then returns the task once', () => {
    const i = base()
    expect(stalledToRequeue({ ...i, now: 0 })).toEqual([])
    expect(stalledToRequeue({ ...i, now: 10_000 })).toEqual([])
    expect(stalledToRequeue({ ...i, now: 16_000 })).toEqual([
      { campaignId: 'c', taskId: 'a' },
    ])
    expect(
      stalledToRequeue({ ...i, already: new Set(['a']), now: 17_000 })
    ).toEqual([])
  })

  it('ignores a task with a live run, an ending or queued input', () => {
    for (const patch of [
      { live: new Set(['s1']) },
      { ended: () => true },
      { hasReady: () => true },
    ]) {
      const i = { ...base(), ...patch }
      stalledToRequeue({ ...i, now: 0 })
      expect(stalledToRequeue({ ...i, now: 99_000 })).toEqual([])
    }
  })
})
