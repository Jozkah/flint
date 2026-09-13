import { describe, it, expect } from 'vitest'
import type { TeamState, TeamTask } from '@/lib/coworkTeam'
import {
  TeamControl,
  applyReplacement,
  awaitingDecision,
  checkRequest,
  reopen,
} from '@/lib/coworkTeamControl'

const task = (id: string, dependsOn: string[] = [], extra: Partial<TeamTask> = {}): TeamTask => ({
  id,
  description: `do ${id}`,
  dependsOn,
  writes: [],
  ...extra,
})

// a fails; b depends on a; c depends on b; d depends on x, which also failed.
const graph = [task('a'), task('b', ['a']), task('c', ['b']), task('x'), task('d', ['x'])]
const failedState: TeamState = {
  a: { status: 'failed' },
  b: { status: 'blocked' },
  c: { status: 'blocked' },
  x: { status: 'failed' },
  d: { status: 'blocked' },
}

describe('coworkTeamControl (AH-111)', () => {
  it('restarts only a failed task of a team that is still running', () => {
    expect(checkRequest(graph, failedState, { kind: 'restart', taskId: 'a' }, false)).toEqual({ ok: true })
    const blocked = checkRequest(graph, failedState, { kind: 'restart', taskId: 'b' }, false)
    expect(blocked).toMatchObject({ ok: false, refusal: { kind: 'not-failed' } })
    const missing = checkRequest(graph, failedState, { kind: 'restart', taskId: 'zz' }, false)
    expect(missing).toMatchObject({ ok: false, refusal: { kind: 'not-found' } })
    const over = checkRequest(graph, failedState, { kind: 'restart', taskId: 'a' }, true)
    expect(over).toMatchObject({ ok: false, refusal: { kind: 'team-finished' } })
  })

  it('refuses a replacement that changes nothing or is empty', () => {
    const same = checkRequest(graph, failedState, { kind: 'replace', taskId: 'a', with: { description: 'do a' } }, false)
    expect(same).toMatchObject({ ok: false, refusal: { kind: 'invalid-replacement' } })
    const empty = checkRequest(graph, failedState, { kind: 'replace', taskId: 'a', with: { description: '   ' } }, false)
    expect(empty).toMatchObject({ ok: false, refusal: { kind: 'invalid-replacement' } })
    const nothing = checkRequest(graph, failedState, { kind: 'replace', taskId: 'a', with: {} }, false)
    expect(nothing).toMatchObject({ ok: false, refusal: { kind: 'invalid-replacement' } })
    const agent = checkRequest(graph, failedState, { kind: 'replace', taskId: 'a', with: { subagentName: 'reviewer' } }, false)
    expect(agent).toEqual({ ok: true })
  })

  it('replaces the brief or the agent of that task only', () => {
    const next = applyReplacement(graph, 'a', { subagentName: ' reviewer ', description: ' fix a properly ' })
    expect(next.find((t) => t.id === 'a')).toMatchObject({ subagentName: 'reviewer', description: 'fix a properly' })
    expect(next.filter((t) => t.id !== 'a')).toEqual(graph.filter((t) => t.id !== 'a'))
  })

  it('reopens the task and what it alone was blocking, never what another failure blocks', () => {
    const next = reopen(graph, failedState, 'a')
    expect(next.a.status).toBe('pending')
    expect(next.b.status).toBe('pending')
    expect(next.c.status).toBe('pending')
    // d is still blocked by x, which is still failed.
    expect(next.d.status).toBe('blocked')
    expect(next.x.status).toBe('failed')
  })

  it('holds for a decision only while something has failed', () => {
    expect(awaitingDecision(failedState)).toBe(true)
    expect(awaitingDecision({ a: { status: 'completed' }, b: { status: 'cancelled' } })).toBe(false)
  })

  it('delivers requests in order and wakes a waiting team', async () => {
    const control = new TeamControl()
    let woke = false
    const waiting = control.next().then(() => {
      woke = true
    })
    control.request({ kind: 'restart', taskId: 'a' })
    control.request({ kind: 'finish' })
    await waiting
    expect(woke).toBe(true)
    expect(control.take()).toEqual([{ kind: 'restart', taskId: 'a' }, { kind: 'finish' }])
    expect(control.take()).toEqual([])
  })

  it('stops waiting when the run is stopped, or when the window passes', async () => {
    const control = new TeamControl()
    const stop = new AbortController()
    const waiting = control.next(stop.signal)
    stop.abort()
    await expect(waiting).resolves.toBe(false)
    await expect(new TeamControl().next(undefined, 10)).resolves.toBe(false)
    const asked = new TeamControl()
    const pending = asked.next(undefined, 1000)
    asked.request({ kind: 'finish' })
    await expect(pending).resolves.toBe(true)
  })
})
