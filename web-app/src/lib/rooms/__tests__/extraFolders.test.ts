import { describe, expect, it } from 'vitest'
import { MAX_EXTRA_FOLDERS, cleanExtraFolders } from '../controller'

describe('cleanExtraFolders', () => {
  it('trims, drops repeats and the main folder, and keeps the order', () => {
    expect(
      cleanExtraFolders([' C:/a ', 'C:/b', 'C:/a', '', 'C:/main'], 'C:/main')
    ).toEqual(['C:/a', 'C:/b'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `C:/f${i}`)
    expect(cleanExtraFolders(many, null)).toHaveLength(MAX_EXTRA_FOLDERS)
  })

  it('ignores anything that is not a path string', () => {
    expect(cleanExtraFolders([null as never, 3 as never, 'C:/ok'], null)).toEqual(['C:/ok'])
  })
})
