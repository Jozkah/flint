import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const m = vi.hoisted(() => ({
  panel: null as null | Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  copyOf: vi.fn(),
  hunk: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/containers/CoworkCodePanel', () => ({
  CoworkCodePanel: (props: Record<string, unknown>) => {
    m.panel = props
    return null
  },
}))
vi.mock('@/lib/coworkSandboxApply', () => ({
  sandboxCopyOfProjectFile: (...a: unknown[]) => m.copyOf(...a),
  applySandboxHunk: (...a: unknown[]) => m.hunk(...a),
}))
vi.mock('sonner', () => ({ toast: m.toast }))
vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/hooks/useCoworkSessions', () => ({
  useCoworkSessions: { getState: () => ({ setCodePanel: vi.fn() }) },
}))

import { CoworkCodeRail } from '../CoworkCodeRail'

const git = { refresh: vi.fn() }
const props = (over: Record<string, unknown> = {}) =>
  ({
    sessionId: 's1',
    codePanel: undefined,
    turns: [],
    folder: '/proj',
    treeRoot: '/proj',
    workspacePath: '/ws',
    extraFolders: [],
    destination: 'folder',
    relativeIsProject: true,
    writeGrant: 'g1',
    sandboxApply: undefined,
    fileDiffs: [{ path: '/ws/a.ts' }],
    git,
    onAttachFolder: vi.fn(),
    onAddToChat: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }) as never

describe('CoworkCodeRail', () => {
  beforeEach(() => {
    m.panel = null
    m.copyOf.mockReset()
    m.hunk.mockReset()
    git.refresh.mockClear()
  })

  it('reads the run tree and saves edits under the live grant', () => {
    render(<CoworkCodeRail {...props()} />)
    expect(m.panel?.folder).toBe('/proj')
    expect(m.panel?.projectName).toBe('proj')
    expect(m.panel?.editAccess).toEqual({ destination: 'folder', writeGrant: 'g1' })
    m.panel?.onSaved()
    expect(git.refresh).toHaveBeenCalled()
  })

  it('drops the grant when relative paths are the sandbox\'s', () => {
    render(<CoworkCodeRail {...props({ relativeIsProject: false })} />)
    expect(m.panel?.editAccess.writeGrant).toBeNull()
  })

  it('offers no sandbox hunk apply without sandbox actions', () => {
    render(<CoworkCodeRail {...props()} />)
    expect(m.panel?.onApplySandboxHunk).toBeUndefined()
    expect(m.panel?.sandboxCopyFor('x.ts')).toBeNull()
  })

  it('applies a hunk to the sandbox copy and refreshes git', async () => {
    m.copyOf.mockReturnValue({
      path: '/ws/a.ts',
      plan: { source: '/ws/a.ts', folder: '/proj', destination: '/proj/a.ts' },
    })
    m.hunk.mockResolvedValue('applied')
    render(<CoworkCodeRail {...props({ sandboxApply: { planFor: vi.fn(), apply: vi.fn() } })} />)
    const out = await m.panel?.onApplySandboxHunk('a.ts', 'old', 'new')
    expect(out).toBe('applied')
    expect(m.hunk).toHaveBeenCalledWith(
      expect.objectContaining({ session: 's1', expected: 'old', content: 'new' })
    )
    expect(git.refresh).toHaveBeenCalled()
  })

  it('throws when the project file has no sandbox copy', async () => {
    m.copyOf.mockReturnValue(null)
    render(<CoworkCodeRail {...props({ sandboxApply: { planFor: vi.fn(), apply: vi.fn() } })} />)
    await expect(m.panel?.onApplySandboxHunk('a.ts', 'o', 'n')).rejects.toThrow(/no sandbox copy/)
  })

  it('applies a whole sandbox copy and reports the result', async () => {
    m.copyOf.mockReturnValue({ path: '/ws/a.ts', plan: { source: '/ws/a.ts' } })
    const apply = vi.fn().mockResolvedValue(undefined)
    render(<CoworkCodeRail {...props({ sandboxApply: { planFor: vi.fn(), apply } })} />)
    m.panel?.onApplySandboxCopy('a.ts')
    await vi.waitFor(() => expect(m.toast.success).toHaveBeenCalled())
    expect(apply).toHaveBeenCalledWith('/ws/a.ts', true)
  })
})
