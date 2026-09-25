import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { applySandboxFile, sandboxRelativePath } from '../coworkSandboxApply'

describe('sandboxRelativePath', () => {
  it('strips the sandbox root from an absolute path', () => {
    expect(sandboxRelativePath('C:\\data\\s1', 'C:\\data\\s1\\docs\\a.md')).toBe('docs/a.md')
    expect(sandboxRelativePath('/data/s1', '/data/s1/a.md')).toBe('a.md')
  })
  it('keeps a path that is already relative', () => {
    expect(sandboxRelativePath('/data/s1', './docs/a.md')).toBe('docs/a.md')
    expect(sandboxRelativePath(null, 'a.md')).toBe('a.md')
  })
  it('refuses an absolute path outside the sandbox', () => {
    expect(sandboxRelativePath('/data/s1', '/etc/passwd')).toBeNull()
    expect(sandboxRelativePath('C:\\data\\s1', 'D:\\x.md')).toBeNull()
    expect(sandboxRelativePath('/data/s1', '/data/s1')).toBeNull()
  })
})

describe('applySandboxFile', () => {
  it('calls the backend command with the session, path and folder', async () => {
    invoke.mockResolvedValueOnce('created')
    const input = { session: 's1', path: 'a.md', project: '/p', overwrite: false }
    await expect(applySandboxFile(input)).resolves.toBe('created')
    expect(invoke).toHaveBeenCalledWith('agent_sandbox_apply_file', input)
  })
})
