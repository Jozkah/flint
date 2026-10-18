import { describe, expect, it } from 'vitest'
import { displayPath } from '@/lib/settingsRecoveryNotice'

describe('displayPath', () => {
  it('uses one separator for a Windows path', () => {
    expect(displayPath('C:\\Users\\a/data/settings.json')).toBe(
      'C:\\Users\\a\\data\\settings.json'
    )
  })
  it('leaves a POSIX path alone', () => {
    expect(displayPath('/home/a/settings.json')).toBe('/home/a/settings.json')
  })
})
