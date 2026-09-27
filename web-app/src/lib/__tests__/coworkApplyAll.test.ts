import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  autoApplicable,
  planApplyAll,
  probeSandboxFile,
  runApplyAll,
  type ApplyAllEntry,
} from '../coworkApplyAll'
import type { SandboxApplyPlan } from '../coworkSandboxApply'

const plan = (path: string): SandboxApplyPlan => ({
  source: path,
  folder: '/proj',
  destination: path,
  remapped: false,
})

describe('planApplyAll', () => {
  it('ticks new files, flags and unticks overwrites, and says why others are skipped', async () => {
    const probes: Record<string, 'new' | 'same' | 'differs'> = {
      'a.md': 'new',
      'b.md': 'differs',
      'c.md': 'same',
    }
    const entries = await planApplyAll(
      ['a.md', 'b.md', 'c.md', 'outside.md', 'broken.md'],
      (p) => (p === 'outside.md' ? null : plan(p)),
      async (p) => {
        if (p === 'broken.md') throw new Error('the sandbox file is gone')
        return probes[p]
      }
    )
    expect(entries.map((e) => [e.path, e.kind])).toEqual([
      ['a.md', 'apply'],
      ['b.md', 'apply'],
      ['c.md', 'skip'],
      ['outside.md', 'skip'],
      ['broken.md', 'skip'],
    ])
    expect(entries[0]).toMatchObject({ probe: 'new', checked: true })
    expect(entries[1]).toMatchObject({ probe: 'differs', checked: false })
    expect(entries[2]).toMatchObject({ reason: 'same' })
    expect(entries[3]).toMatchObject({ reason: 'not-in-sandbox' })
    expect(entries[4]).toMatchObject({
      reason: { message: 'the sandbox file is gone' },
    })
  })
})

describe('runApplyAll', () => {
  const entries: ApplyAllEntry[] = [
    { kind: 'apply', path: 'a.md', plan: plan('a.md'), probe: 'new', checked: true },
    { kind: 'apply', path: 'b.md', plan: plan('b.md'), probe: 'differs', checked: true },
    { kind: 'apply', path: 'c.md', plan: plan('c.md'), probe: 'differs', checked: false },
    { kind: 'apply', path: 'd.md', plan: plan('d.md'), probe: 'new', checked: true },
    { kind: 'skip', path: 'e.md', plan: null, reason: 'not-in-sandbox' },
  ]

  it('applies ticked files in order, overwriting only a flagged one the user ticked', async () => {
    const apply = vi.fn(async (path: string) =>
      path === 'b.md' ? ('replaced' as const) : path === 'd.md' ? ('exists' as const) : ('created' as const)
    )
    const seen: string[] = []
    const results = await runApplyAll(entries, apply, (r) => seen.push(r.path))
    expect(apply.mock.calls).toEqual([
      ['a.md', false],
      ['b.md', true],
      ['d.md', false],
    ])
    expect(seen).toEqual(['a.md', 'b.md', 'd.md'])
    expect(results).toEqual([
      { path: 'a.md', ok: true, outcome: 'created' },
      { path: 'b.md', ok: true, outcome: 'replaced' },
      // Appeared after the check: reported, never overwritten.
      { path: 'd.md', ok: false, conflict: true },
    ])
  })

  it('keeps going after a failure and reports it', async () => {
    const apply = vi.fn(async (path: string) => {
      if (path === 'a.md') throw new Error('denied')
      return 'created' as const
    })
    const results = await runApplyAll(entries.slice(0, 2), apply)
    expect(results[0]).toEqual({ path: 'a.md', ok: false, message: 'denied' })
    expect(results[1]).toMatchObject({ ok: true })
  })
})

describe('autoApplicable', () => {
  it('applies only new files and leaves every conflict to the user', () => {
    const entries: ApplyAllEntry[] = [
      { kind: 'apply', path: 'a.md', plan: plan('a.md'), probe: 'new', checked: false },
      { kind: 'apply', path: 'b.md', plan: plan('b.md'), probe: 'differs', checked: true },
      { kind: 'skip', path: 'c.md', plan: plan('c.md'), reason: 'same' },
    ]
    const { apply, conflicts } = autoApplicable(entries)
    expect(apply.map((e) => e.path)).toEqual(['a.md'])
    expect(apply[0]).toMatchObject({ checked: true })
    expect(conflicts.map((e) => e.path)).toEqual(['b.md'])
  })
})

describe('probeSandboxFile', () => {
  it('asks the backend dry run', async () => {
    invoke.mockResolvedValueOnce('new')
    const input = { session: 's1', path: 'a.md', project: '/proj', destination: 'a.md' }
    await expect(probeSandboxFile(input)).resolves.toBe('new')
    expect(invoke).toHaveBeenCalledWith('agent_sandbox_apply_probe', input)
  })
})
