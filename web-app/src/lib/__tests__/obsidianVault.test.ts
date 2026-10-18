import { describe, it, expect } from 'vitest'
import { isObsidianVault, type VaultFs } from '../obsidianVault'

/** A fake filesystem: only the listed paths exist, as directories or files. */
function fakeFs(dirs: string[], files: string[] = []): VaultFs & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async fileStat(path) {
      asked.push(path)
      if (dirs.includes(path)) return { isDirectory: true }
      if (files.includes(path)) return { isDirectory: false }
      return undefined
    },
  }
}

describe('isObsidianVault', () => {
  it('is true for a folder that holds a .obsidian folder', async () => {
    const fs = fakeFs(['/notes/Vault/.obsidian'])
    expect(await isObsidianVault('/notes/Vault', fs)).toBe(true)
    expect(fs.asked).toEqual(['/notes/Vault/.obsidian'])
  })

  it('keeps Windows separators and ignores a trailing slash', async () => {
    const fs = fakeFs(['C:\\Users\\me\\Vault\\.obsidian'])
    expect(await isObsidianVault('C:\\Users\\me\\Vault\\', fs)).toBe(true)
  })

  it('is false for a plain folder', async () => {
    expect(await isObsidianVault('/notes/Plain', fakeFs([]))).toBe(false)
  })

  it('is false when .obsidian is a file, not a folder', async () => {
    const fs = fakeFs([], ['/notes/Odd/.obsidian'])
    expect(await isObsidianVault('/notes/Odd', fs)).toBe(false)
  })

  it('is false for no folder, and when the check throws', async () => {
    expect(await isObsidianVault(null, fakeFs([]))).toBe(false)
    const throwing: VaultFs = {
      fileStat: async () => {
        throw new Error('denied')
      },
    }
    expect(await isObsidianVault('/x', throwing)).toBe(false)
  })
})
