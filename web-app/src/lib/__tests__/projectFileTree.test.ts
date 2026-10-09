import { describe, expect, it } from 'vitest'
import { buildProjectFileTree } from '../projectFileTree'

const f = (path?: string) => ({ id: path ?? 'none', path })

describe('buildProjectFileTree', () => {
  it('stays flat when every file shares one folder', () => {
    const { nodes, hasFolders } = buildProjectFileTree([
      f('C:\docs\a.md'),
      f('C:\docs\b.md'),
    ])
    expect(hasFolders).toBe(false)
    expect(nodes.map((n) => n.kind)).toEqual(['file', 'file'])
  })

  it('nests subfolders below the shared root', () => {
    const { nodes, hasFolders } = buildProjectFileTree([
      f('/home/u/proj/readme.md'),
      f('/home/u/proj/src/a.ts'),
      f('/home/u/proj/src/lib/b.ts'),
    ])
    expect(hasFolders).toBe(true)
    expect(nodes).toHaveLength(2)
    const src = nodes.find((n) => n.kind === 'folder')!
    expect(src.kind === 'folder' && src.name).toBe('src')
    expect(src.kind === 'folder' && src.children.map((c) => c.kind)).toEqual([
      'file',
      'folder',
    ])
  })

  it('splits Windows paths', () => {
    const { nodes, hasFolders } = buildProjectFileTree([
      f('C:\\p\\a.md'),
      f('C:\\p\\sub\\b.md'),
    ])
    expect(hasFolders).toBe(true)
    expect(nodes.map((n) => n.kind)).toEqual(['file', 'folder'])
  })

  it('keeps files without a path at the top', () => {
    const { nodes } = buildProjectFileTree([f(undefined), f('/x/a.md')])
    expect(nodes).toHaveLength(2)
    expect(nodes.every((n) => n.kind === 'file')).toBe(true)
  })
})
