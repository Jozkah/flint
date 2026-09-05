import { describe, it, expect, vi } from 'vitest'
import {
  childSessionId,
  describeDestinations,
  planDestinations,
  type DestinationDeps,
} from '@/lib/coworkTeamDestinations'
import type { TeamTask } from '@/lib/coworkTeam'

const task = (id: string, over: Partial<TeamTask> = {}): TeamTask => ({
  id,
  description: `brief for ${id}`,
  dependsOn: [],
  writes: [],
  ...over,
})

const deps = (over: Partial<DestinationDeps> = {}): DestinationDeps => ({
  parentSessionId: 'session-1',
  project: '/repo',
  dataFolder: '/data',
  canIsolate: true,
  ensure: vi.fn(async (owner: string) => ({
    ok: true as const,
    record: {
      path: `/data/worktrees/${owner}`,
      branch: `jan/cowork/${owner}`,
      baseSha: 'a'.repeat(40),
      uncommittedAtCreation: [],
    },
  })),
  authorize: vi.fn(async (owner: string) => ({
    ok: true as const,
    grant: { grantId: `grant-${owner}` },
  })),
  revoke: vi.fn(async () => true),
  ...over,
})

describe('planning where a team’s isolated children write', () => {
  it('gives every isolated task a checkout of its own', async () => {
    const plan = await planDestinations(
      [task('a', { isolate: true }), task('b', { isolate: true }), task('c')],
      deps()
    )

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const a = plan.byTask.get('a')
    const b = plan.byTask.get('b')
    expect(a?.path).toBeTruthy()
    expect(b?.path).toBeTruthy()
    // The property the whole thing exists for.
    expect(a?.path).not.toEqual(b?.path)
    expect(a?.grantId).not.toEqual(b?.grantId)
    expect(a?.ownerId).not.toEqual(b?.ownerId)
    // A task that did not ask stays in the run's own destination.
    expect(plan.byTask.has('c')).toBe(false)
  })

  it('plans nothing, and asks nothing, when no task isolates', async () => {
    const d = deps()
    const plan = await planDestinations([task('a'), task('b')], d)
    expect(plan.ok && plan.byTask.size).toBe(0)
    expect(d.ensure).not.toHaveBeenCalled()
    expect(d.authorize).not.toHaveBeenCalled()
  })

  it('refuses the whole team when one checkout cannot be created', async () => {
    // Half a team isolated is worse than none: the tasks that did get a
    // checkout have already been promised something the rest are not getting.
    const d = deps({
      ensure: vi.fn(async (owner: string) =>
        owner.endsWith('b')
          ? {
              ok: false as const,
              reason: 'a branch of that name already exists',
            }
          : {
              ok: true as const,
              record: {
                path: `/data/worktrees/${owner}`,
                branch: 'jan/cowork/x',
                baseSha: 'a'.repeat(40),
                uncommittedAtCreation: [],
              },
            }
      ),
    })
    const plan = await planDestinations(
      [task('a', { isolate: true }), task('b', { isolate: true })],
      d
    )

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal).toContain('already exists')
    // And the one that succeeded does not keep its authority.
    expect(d.revoke).toHaveBeenCalledWith(childSessionId('session-1', 'a'))
  })

  it('refuses rather than falling back when a checkout cannot be written', async () => {
    const d = deps({
      authorize: vi.fn(async () => ({
        ok: false as const,
        reason: 'superseded',
      })),
    })
    const plan = await planDestinations([task('a', { isolate: true })], d)

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.refusal).toContain('could not be authorized')
    expect(d.revoke).toHaveBeenCalled()
  })

  it('refuses isolation with no folder attached, and with no capability', async () => {
    const nothing = await planDestinations(
      [task('a', { isolate: true })],
      deps({ project: null })
    )
    expect(nothing.ok).toBe(false)
    if (!nothing.ok) expect(nothing.refusal).toContain('no folder attached')

    const cannot = await planDestinations(
      [task('a', { isolate: true })],
      deps({ canIsolate: false })
    )
    expect(cannot.ok).toBe(false)
    if (!cannot.ok)
      expect(cannot.refusal).toContain('cannot give a task its own')
  })

  it('hands every grant back when the team is over', async () => {
    const d = deps()
    const plan = await planDestinations(
      [task('a', { isolate: true }), task('b', { isolate: true })],
      d
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    await plan.release()

    expect(d.revoke).toHaveBeenCalledTimes(2)
    // Releasing twice is not two withdrawals.
    await plan.release()
    expect(d.revoke).toHaveBeenCalledTimes(2)
  })

  it('names where the work is, and what those checkouts could not see', async () => {
    const plan = await planDestinations(
      [task('a', { isolate: true })],
      deps({
        ensure: vi.fn(async (owner: string) => ({
          ok: true as const,
          record: {
            path: `/data/worktrees/${owner}`,
            branch: 'jan/cowork/x',
            baseSha: 'abcdef1234567890',
            uncommittedAtCreation: ['src/edited.ts'],
          },
        })),
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    const said = describeDestinations(plan.byTask)
    expect(said).toContain('/data/worktrees/')
    expect(said).toContain('abcdef12')
    expect(said).toContain('not in the attached folder')
    expect(said).toContain('uncommitted changes')
    expect(describeDestinations(new Map())).toBe('')
  })

  it('derives a child id that is safe to use as a name', () => {
    const id = childSessionId('session-1', '../../etc/passwd')
    expect(id.startsWith('session-1--child-')).toBe(true)
    expect(/^[A-Za-z0-9._-]+$/.test(id)).toBe(true)
    // Distinct tasks are distinct owners, which is what keeps two grants alive.
    expect(childSessionId('s', 'a')).not.toEqual(childSessionId('s', 'b'))
  })
})
