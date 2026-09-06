import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProjectMap } from '@janhq/tauri-plugin-agent-tools-api'

const h = vi.hoisted(() => ({ projectMap: vi.fn() }))

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  projectMap: h.projectMap,
}))

import {
  REPO_MAP_MAX_BYTES,
  renderRepositoryMap,
  walkRepositoryMap,
} from '@/lib/coworkRepoMap'

const walked = (over: Partial<ProjectMap> = {}): ProjectMap => ({
  entries: [],
  truncated: false,
  depthLimited: false,
  sensitiveOmitted: 0,
  unreadableDirs: 0,
  files: 0,
  dirs: 0,
  ...over,
})

const file = (relPath: string, depth: number) => ({
  relPath,
  isDir: false,
  depth,
})
const dir = (relPath: string, depth: number) => ({
  relPath,
  isDir: true,
  depth,
})

describe('renderRepositoryMap', () => {
  it('prints a tree in reading order, not the order it was walked in', () => {
    // Breadth-first is how the walk spends its budget; a parent immediately
    // followed by its children is how the result has to read.
    const render = renderRepositoryMap(
      walked({
        entries: [
          dir('src', 1),
          file('README.md', 1),
          dir('src/deep', 2),
          file('src/main.ts', 2),
          file('src/deep/inner.ts', 3),
        ],
        files: 3,
        dirs: 2,
      })
    )
    const lines = render.text.split('\n')
    expect(lines[0]).toBe('# Repository map')
    expect(lines.slice(4, 10)).toEqual([
      'src/',
      '  deep/',
      '    inner.ts',
      '  main.ts',
      'README.md',
      '',
    ])
    expect(render.entriesShown).toBe(5)
    expect(render.entriesTrimmed).toBe(0)
  })

  it('counts what was found, not what it printed', () => {
    const render = renderRepositoryMap(
      walked({ entries: [file('a.ts', 1)], files: 1, dirs: 0 })
    )
    expect(render.text).toContain('0 directories, 1 file found.')
  })

  it('says so when the walk stopped short', () => {
    const render = renderRepositoryMap(
      walked({
        entries: [file('a.ts', 1)],
        files: 1,
        truncated: true,
        depthLimited: true,
        sensitiveOmitted: 2,
        unreadableDirs: 1,
      })
    )
    expect(render.text).toContain('stopped at its entry limit')
    expect(render.text).toContain('below the depth limit')
    expect(render.text).toContain('2 credential-looking files are omitted')
    expect(render.text).toContain('1 directory could not be read')
  })

  it('never names an omitted credentials file', () => {
    // The count is the whole report: the path of a `.env` is itself a pointer,
    // and this text goes into a prompt.
    const render = renderRepositoryMap(
      walked({ entries: [file('a.ts', 1)], files: 1, sensitiveOmitted: 1 })
    )
    expect(render.text).not.toMatch(/\.env|id_rsa/)
  })

  it('trims the deepest entries to fit its budget and says how many', () => {
    const entries = [
      dir('src', 1),
      ...Array.from({ length: 200 }, (_, i) =>
        file(`src/very-long-file-name-number-${i}.ts`, 2)
      ),
      ...Array.from({ length: 200 }, (_, i) =>
        file(`src/nested/deeper-file-number-${i}.ts`, 3)
      ),
    ]
    const render = renderRepositoryMap(
      walked({ entries, files: 400, dirs: 1 }),
      1200
    )
    expect(new TextEncoder().encode(render.text).length).toBeLessThanOrEqual(
      1200
    )
    expect(render.entriesTrimmed).toBeGreaterThan(0)
    expect(render.text).toContain('size budget')
    // What survives is the top of the tree: that is the part that orients.
    expect(render.text).toContain('src/')
    expect(render.text).not.toContain('deeper-file-number-199')
  })

  it('is byte-identical for the same tree', () => {
    const tree = walked({
      entries: [dir('a', 1), file('b.ts', 1), file('a/c.ts', 2)],
      files: 2,
      dirs: 1,
    })
    expect(renderRepositoryMap(tree).text).toBe(renderRepositoryMap(tree).text)
  })

  it('renders nothing for no map at all', () => {
    expect(renderRepositoryMap(null).text).toBe('')
    expect(renderRepositoryMap(walked()).text).toBe('')
  })

  it('keeps an entry whose parent the walk never reached', () => {
    // The entry budget can end a level mid-way, leaving a child with no parent
    // line. Dropping it silently would be the one thing this module refuses.
    const render = renderRepositoryMap(
      walked({ entries: [file('orphan/child.ts', 2)], files: 1 })
    )
    expect(render.text).toContain('child.ts')
    expect(render.entriesShown).toBe(1)
  })
})

describe('walkRepositoryMap', () => {
  beforeEach(() => {
    h.projectMap.mockReset()
  })

  it('walks the root it is given, through the backend', async () => {
    h.projectMap.mockResolvedValue(
      walked({ entries: [file('a.ts', 1)], files: 1 })
    )
    const result = await walkRepositoryMap('/data', '/repo')
    expect(h.projectMap).toHaveBeenCalledWith('/data', '/repo')
    expect(result.error).toBeNull()
    expect(result.text).toContain('a.ts')
    expect(result.render?.entriesShown).toBe(1)
  })

  it('is not an error to have no folder attached', async () => {
    const result = await walkRepositoryMap('/data', null)
    expect(result).toEqual({ text: null, error: null, render: null })
    expect(h.projectMap).not.toHaveBeenCalled()
  })

  it('reports a refusal rather than inventing a map', async () => {
    h.projectMap.mockRejectedValue(new Error('path escapes the project root'))
    const result = await walkRepositoryMap('/data', '/repo')
    expect(result.text).toBeNull()
    expect(result.error).toBe('path escapes the project root')
  })

  it('reports a missing data folder as the failure it is', async () => {
    const result = await walkRepositoryMap(null, '/repo')
    expect(result.error).toBe('data folder unavailable')
    expect(h.projectMap).not.toHaveBeenCalled()
  })

  it('has a budget by default', () => {
    expect(REPO_MAP_MAX_BYTES).toBeGreaterThan(0)
  })
})
