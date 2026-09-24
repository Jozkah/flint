import { describe, it, expect, vi } from 'vitest'
import {
  collectFilesFromDirectory,
  MAX_WALK_DEPTH,
  type WalkFs,
} from '../directoryWalk'

const acceptAll = () => true

describe('collectFilesFromDirectory', () => {
  it('does not follow a symlinked directory that loops back', async () => {
    // /p contains a.txt and loop -> /p
    const fs: WalkFs = {
      readdirSync: vi.fn(async (dir: string) => [`${dir}/a.txt`, `${dir}/loop`]),
      fileStat: vi.fn(async (path: string) =>
        path.endsWith('/loop')
          ? { isDirectory: true, isSymlink: true, size: 0 }
          : { isDirectory: false, size: 1 }
      ),
    }
    const files = await collectFilesFromDirectory('/p', fs, acceptAll)
    expect(files).toEqual(['/p/a.txt'])
    expect(fs.readdirSync).toHaveBeenCalledTimes(1)
  })

  it('stops at the depth cap when a cycle is not reported as a symlink', async () => {
    const fs: WalkFs = {
      readdirSync: vi.fn(async (dir: string) => [`${dir}/d`]),
      fileStat: vi.fn(async () => ({ isDirectory: true, size: 0 })),
    }
    const files = await collectFilesFromDirectory('/p', fs, acceptAll)
    expect(files).toEqual([])
    expect(fs.readdirSync).toHaveBeenCalledTimes(MAX_WALK_DEPTH + 1)
  })

  it('keeps only accepted files from real subdirectories', async () => {
    const tree: Record<string, string[]> = {
      '/p': ['/p/sub', '/p/x.bin'],
      '/p/sub': ['/p/sub/y.md'],
    }
    const fs: WalkFs = {
      readdirSync: async (dir) => tree[dir] ?? [],
      fileStat: async (path) => ({ isDirectory: path in tree, size: 0 }),
    }
    const files = await collectFilesFromDirectory('/p', fs, (p) =>
      p.endsWith('.md')
    )
    expect(files).toEqual(['/p/sub/y.md'])
  })
})
