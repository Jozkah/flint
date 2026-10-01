import { describe, it, expect, vi } from 'vitest'
import { codePathExists } from '../codePathExists'

const probe = (over: Partial<Parameters<typeof codePathExists>[1]> = {}) => ({
  project: vi.fn(async () => ({})),
  sandboxMissing: vi.fn(async () => false),
  ...over,
})

describe('codePathExists', () => {
  it('is true for a project file that reads', async () => {
    const p = probe()
    expect(await codePathExists({ kind: 'project', rel: 'a.ts' }, p)).toBe(true)
    expect(p.project).toHaveBeenCalledWith('a.ts')
  })

  it('is false only for a definite not-found', async () => {
    const gone = probe({
      project: vi.fn(async () => {
        throw new Error('x is unreadable: (os error 2)')
      }),
    })
    expect(await codePathExists({ kind: 'project', rel: 'x.ts' }, gone)).toBe(false)
    const denied = probe({
      project: vi.fn(async () => {
        throw new Error('DENIED: nope')
      }),
    })
    expect(await codePathExists({ kind: 'project', rel: 'x.ts' }, denied)).toBe(true)
  })

  it('asks the sandbox probe for sandbox paths and trusts unresolved ones', async () => {
    const p = probe({ sandboxMissing: vi.fn(async () => true) })
    expect(await codePathExists({ kind: 'sandbox', rel: 'a.ts' }, p)).toBe(false)
    expect(
      await codePathExists({ kind: 'unresolved', reason: 'outside' }, p)
    ).toBe(true)
  })
})
