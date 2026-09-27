import { describe, it, expect, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import {
  applySandboxFile,
  isFlintInternalPath,
  planSandboxApply,
  sandboxCopyOfProjectFile,
  sandboxRelativePath,
} from '../coworkSandboxApply'

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

describe('planSandboxApply', () => {
  const sandbox = 'C:\\data\\s1'
  const folder = 'C:\\Users\\me\\Coding\\KewScraper'

  it('offers nothing for a real file Flint edited in place', () => {
    expect(
      planSandboxApply(sandbox, [folder], 'C:\\Users\\me\\Coding\\KewScraper\\main.go')
    ).toBeNull()
    expect(planSandboxApply(sandbox, [], 'docs/a.md')).toBeNull()
  })

  it('drops a mirrored folder name instead of nesting the project in itself', () => {
    expect(planSandboxApply(sandbox, [folder], 'KewScraper/go.mod')).toEqual({
      source: 'KewScraper/go.mod',
      folder,
      destination: 'go.mod',
      remapped: true,
    })
  })

  it('keeps an ordinary sandbox path as it is, in the first folder', () => {
    expect(planSandboxApply(sandbox, [folder, 'D:\\other'], 'docs/a.md')).toEqual({
      source: 'docs/a.md',
      folder,
      destination: 'docs/a.md',
      remapped: false,
    })
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

describe('isFlintInternalPath', () => {
  const sandbox = 'C:/Users/me/AppData/Roaming/Flint/data/agent-workspace/sessions/s1'
  const data = 'C:/Users/me/AppData/Roaming/Flint/data'

  it('leaves real session output alone', () => {
    expect(isFlintInternalPath(sandbox, `${sandbox}/report.md`)).toBe(false)
    expect(isFlintInternalPath(sandbox, 'src/app.go')).toBe(false)
    expect(isFlintInternalPath(sandbox, 'C:/Users/me/proj/a.md')).toBe(false)
  })

  it('drops Flint’s own settings inside the sandbox', () => {
    expect(isFlintInternalPath(sandbox, `${sandbox}/.jan/agent/agent.toml`)).toBe(true)
    expect(isFlintInternalPath(sandbox, '.jan/agent/hooks.toml')).toBe(true)
  })

  it('drops the rest of the data folder: memory, logs, other sessions', () => {
    expect(isFlintInternalPath(sandbox, `${data}/agent-workspace/memory/notes.md`)).toBe(true)
    expect(isFlintInternalPath(sandbox, `${data}\\logs\\app.log`)).toBe(true)
    expect(isFlintInternalPath(sandbox, `${data}/agent-workspace/sessions/s2/x.md`)).toBe(true)
  })

  it('keeps Flint-owned worktrees, which hold real work', () => {
    expect(isFlintInternalPath(sandbox, `${data}/agent-workspace/worktrees/w1/main.go`)).toBe(false)
  })

  it('offers no Apply for an internal file', () => {
    expect(planSandboxApply(sandbox, ['C:/proj'], `${sandbox}/.jan/agent/agent.toml`)).toBeNull()
  })
})

describe('sandboxCopyOfProjectFile', () => {
  const planFor = (path: string) =>
    planSandboxApply('/data/sessions/s1', ['/work/proj'], path)

  it('finds the sandbox copy mapped to a project file the way Apply maps it', () => {
    const paths = ['/data/sessions/s1/proj/src/a.ts', 'notes.md']
    expect(sandboxCopyOfProjectFile(paths, planFor, '/work/proj', 'src/a.ts')).toMatchObject({
      path: '/data/sessions/s1/proj/src/a.ts',
      plan: { source: 'proj/src/a.ts', destination: 'src/a.ts' },
    })
    expect(sandboxCopyOfProjectFile(paths, planFor, '/work/proj', 'notes.md')?.path).toBe('notes.md')
    expect(sandboxCopyOfProjectFile(paths, planFor, '/work/proj', 'other.ts')).toBeNull()
    expect(sandboxCopyOfProjectFile(paths, planFor, '/elsewhere', 'notes.md')).toBeNull()
  })
})
