import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  projectListDir: vi.fn(),
  projectReadFile: vi.fn(),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => api)

import {
  folderKey,
  resolveAlias,
  useReferenceAliases,
} from '../referenceAliases'

beforeEach(() => {
  vi.clearAllMocks()
  useReferenceAliases.setState({ byFolder: {} })
})

const store = () => useReferenceAliases.getState()

describe('reference aliases (AH-205)', () => {
  it('names a path inside the folder and lists it for that folder only', () => {
    const out = store().add('C:\\repo', 'spec', 'docs\\api.md')
    expect(out).toMatchObject({ ok: true, alias: { target: 'docs/api.md' } })
    expect(
      store()
        .list('c:/repo/')
        .map((a) => a.name)
    ).toEqual(['spec'])
    expect(store().list('C:\\other')).toEqual([])
  })

  it.each([
    ['../outside.md', 'target'],
    ['/etc/passwd', 'target'],
    ['C:\\Users\\me\\.ssh\\id_rsa', 'target'],
  ])('refuses to name %s', (target, reason) => {
    expect(store().add('/repo', 'x', target)).toMatchObject({
      ok: false,
      reason,
    })
    expect(store().list('/repo')).toEqual([])
  })

  it('refuses a name the @alias: token could not carry', () => {
    expect(store().add('/repo', 'two words', 'a.md')).toMatchObject({
      ok: false,
      reason: 'name',
    })
  })

  it('refuses to silently repoint a name, naming what it already names', () => {
    store().add('/repo', 'spec', 'a.md')
    const out = store().add('/repo', 'spec', 'b.md')
    expect(out).toMatchObject({ ok: false, reason: 'taken' })
    expect(!out.ok && out.message).toContain('a.md')
    expect(store().list('/repo')[0].target).toBe('a.md')
  })

  it('refuses without a folder, and removes by name', () => {
    expect(store().add(null, 'spec', 'a.md')).toMatchObject({
      ok: false,
      reason: 'no-folder',
    })
    store().add('/repo', 'spec', 'a.md')
    expect(store().remove('/repo', 'spec').ok).toBe(true)
    expect(store().remove('/repo', 'spec')).toMatchObject({
      ok: false,
      reason: 'unknown',
    })
  })

  it('persists only the aliases', () => {
    const options = useReferenceAliases.persist.getOptions()
    store().add('/repo', 'spec', 'a.md')
    const saved = options.partialize!(useReferenceAliases.getState())
    expect(Object.keys(saved)).toEqual(['byFolder'])
  })

  it('treats two spellings of one Windows folder as one', () => {
    expect(folderKey('C:\\Repo\\')).toBe(folderKey('c:/repo'))
  })
})

describe('resolving an alias at use time', () => {
  it('reads what it names through the confined reader', async () => {
    store().add('/repo', 'spec', 'docs/api.md')
    api.projectReadFile.mockResolvedValue({
      relPath: 'docs/api.md',
      size: 3,
      content: 'API',
      oversized: false,
      binary: false,
    })
    const out = await resolveAlias('/data', '/repo', 'spec')
    expect(api.projectReadFile).toHaveBeenCalledWith(
      '/data',
      '/repo',
      'docs/api.md',
      false
    )
    expect(out.ok && out.content).toContain('API')
  })

  // The folder changed since the alias was saved: a symlink now leads out.
  it('refuses, naming the path, when the target now leads outside', async () => {
    store().add('/repo', 'spec', 'docs/api.md')
    api.projectReadFile.mockRejectedValue('path escapes the project root')
    api.projectListDir.mockRejectedValue('path escapes the project root')
    const out = await resolveAlias('/data', '/repo', 'spec')
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain('docs/api.md')
    expect(!out.ok && out.message).toContain('escapes')
  })

  it('reports a broken alias by the path it can no longer find', async () => {
    store().add('/repo', 'spec', 'docs/gone.md')
    api.projectReadFile.mockRejectedValue('not found')
    api.projectListDir.mockRejectedValue('not found')
    const out = await resolveAlias('/data', '/repo', 'spec')
    expect(!out.ok && out.message).toContain('docs/gone.md')
  })

  it('does not resolve an alias from another folder', async () => {
    store().add('/repo', 'spec', 'a.md')
    const out = await resolveAlias('/data', '/other', 'spec')
    expect(out.ok).toBe(false)
    expect(api.projectReadFile).not.toHaveBeenCalled()
  })
})
