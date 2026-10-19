import { describe, it, expect } from 'vitest'
import { isForeignBundledCli, isRootDir } from '../path'

describe('isRootDir (non-Windows test env)', () => {
  it('returns true for "/"', () => {
    expect(isRootDir('/')).toBe(true)
  })

  it.each([
    ['/mnt'],
    ['/media'],
    ['/boot'],
    ['/home'],
    ['/opt'],
    ['/var'],
    ['/usr'],
  ])('returns true for known Linux root %s', (p) => {
    expect(isRootDir(p)).toBe(true)
  })

  it('returns true for root with trailing slash', () => {
    expect(isRootDir('/home/')).toBe(true)
  })

  it('returns false for non-root paths', () => {
    expect(isRootDir('/home/user')).toBe(false)
    expect(isRootDir('/etc')).toBe(false)
    expect(isRootDir('/var/log')).toBe(false)
  })

  it('normalizes backslashes and trailing separators', () => {
    expect(isRootDir('\\home\\')).toBe(true)
  })

  it('returns "/" default for empty string after normalization', () => {
    expect(isRootDir('')).toBe(true)
  })
})

describe('isForeignBundledCli', () => {
  const own = 'C:\\tmp\\qa\\app'
  it('is foreign when the bundled CLI belongs to another install', () => {
    expect(
      isForeignBundledCli(
        'C:\\Users\\me\\AppData\\Local\\Programs\\Flint\\resources\\bin\\flint.exe',
        own
      )
    ).toBe(true)
  })
  it('is not foreign when it is inside this app', () => {
    expect(
      isForeignBundledCli('C:\\tmp\\qa\\app\\resources\\bin\\flint.exe', own)
    ).toBe(false)
    expect(
      isForeignBundledCli('\\\\?\\C:\\TMP\\qa\\app\\resources\\bin\\flint.exe', own)
    ).toBe(false)
  })
  it('leaves a CLI installed elsewhere, or an unknown app dir, alone', () => {
    expect(isForeignBundledCli('/usr/local/bin/flint', '/opt/flint')).toBe(false)
    expect(isForeignBundledCli('C:\\x\\resources\\bin\\flint.exe', null)).toBe(false)
  })
})
