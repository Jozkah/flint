import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  projectListDir: vi.fn(),
  projectReadFile: vi.fn(),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)

import {
  normalizeReference,
  resolveReference,
  searchReferences,
} from '../safeReferences'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('normalizeReference', () => {
  it.each([
    ['src/main.ts', 'src/main.ts'],
    ['./src/./main.ts', 'src/main.ts'],
    ['src\\lib\\a.ts', 'src/lib/a.ts'],
  ])('accepts %s inside the folder', (raw, rel) => {
    expect(normalizeReference(raw)).toEqual({ ok: true, rel })
  })

  it.each([
    ['../secret.txt', 'escapes'],
    ['src/../../x', 'escapes'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Users\\me\\.ssh\\id_rsa', 'absolute'],
    ['c:/windows/win.ini', 'absolute'],
    ['\\\\server\\share\\f', 'absolute'],
    ['~/.ssh/id_rsa', 'absolute'],
    ['file:///etc/passwd', 'absolute'],
    ['', 'empty'],
    ['./', 'empty'],
  ])('refuses %s (%s)', (raw, reason) => {
    expect(normalizeReference(raw)).toEqual({ ok: false, reason })
  })
})

describe('resolveReference', () => {
  it('reads a file through the confined reader, relative to the folder', async () => {
    api.projectReadFile.mockResolvedValue({
      relPath: 'src/a.ts',
      size: 3,
      content: 'abc',
      oversized: false,
      binary: false,
    })
    const out = await resolveReference('/data', '/repo', 'src/a.ts')
    expect(api.projectReadFile).toHaveBeenCalledWith(
      '/data',
      '/repo',
      'src/a.ts',
      false
    )
    expect(out).toMatchObject({ ok: true, kind: 'file' })
    expect(out.ok && out.content).toContain('abc')
  })

  it('never asks the backend about an escaping or absolute reference', async () => {
    for (const raw of ['../x', '/etc/passwd', 'C:\\x']) {
      const out = await resolveReference('/data', '/repo', raw)
      expect(out.ok).toBe(false)
    }
    expect(api.projectReadFile).not.toHaveBeenCalled()
    expect(api.projectListDir).not.toHaveBeenCalled()
  })

  it('resolves nothing when no folder is attached', async () => {
    const out = await resolveReference('/data', null, 'README.md')
    expect(out).toMatchObject({ ok: false, reason: 'no-folder' })
    expect(api.projectReadFile).not.toHaveBeenCalled()
  })

  it("reports the backend's refusal -- a symlink out of the folder, a key file", async () => {
    api.projectReadFile.mockRejectedValue(
      'path escapes the project root: link.txt'
    )
    api.projectListDir.mockRejectedValue(
      'path escapes the project root: link.txt'
    )
    const out = await resolveReference('/data', '/repo', 'link.txt')
    expect(out).toMatchObject({ ok: false, reason: 'refused' })
    expect(!out.ok && out.message).toContain('escapes')
  })

  it('lists a folder when the reference names one', async () => {
    api.projectReadFile.mockRejectedValue('is a directory')
    api.projectListDir.mockResolvedValue({
      entries: [
        { name: 'a.ts', relPath: 'src/a.ts', isDir: false },
        { name: 'lib', relPath: 'src/lib', isDir: true },
      ],
      truncated: false,
    })
    const out = await resolveReference('/data', '/repo', 'src')
    expect(out).toMatchObject({ ok: true, kind: 'directory' })
    expect(out.ok && out.content).toContain('lib/')
  })
})

describe('searchReferences', () => {
  it('offers nothing without an attached folder', async () => {
    expect(await searchReferences('/data', null, 'a')).toEqual([])
    expect(api.projectListDir).not.toHaveBeenCalled()
  })

  it('offers only what the confined listing returns, as folder-relative paths', async () => {
    api.projectListDir.mockImplementation(
      async (_d: string, _r: string, rel: string) =>
        rel === ''
          ? {
              entries: [
                { name: 'src', relPath: 'src', isDir: true },
                { name: 'README.md', relPath: 'README.md', isDir: false },
              ],
              truncated: false,
            }
          : {
              entries: [
                { name: 'main.ts', relPath: 'src/main.ts', isDir: false },
              ],
              truncated: false,
            }
    )
    const found = await searchReferences('/data', '/repo', 'main')
    expect(found.map((e) => e.path)).toEqual(['src/main.ts'])
    expect(found.every((e) => !e.path.startsWith('/'))).toBe(true)
  })
})
