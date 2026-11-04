import { describe, expect, it } from 'vitest'
import { formatBytes, formatSizeCompact } from '@/lib/formatBytes'
import { formatBytes as archiveBytes } from '@/lib/archive'
import { formatBytes as migrationBytes } from '@/lib/migration'
import { formatBytes as monitorBytes } from '@/lib/systemMonitor'
import { formatBytes as memoryBytes } from '@/containers/memory/memoryScopes'

describe('formatSizeCompact', () => {
  it.each([
    [0, '0 B'],
    [Number.NaN, '0 B'],
    [-5, '0 B'],
    [5, '5 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [10 * 1024 * 1024, '10 MB'],
    [1.5 * 1024 ** 3, '1.5 GB'],
    [3 * 1024 ** 4, '3.0 TB'],
    [2048 * 1024 ** 4, '2048 TB'],
  ])('%s -> %s', (input, expected) => {
    expect(formatSizeCompact(input)).toBe(expected)
  })

  it('is the one implementation behind the archive and migration labels', () => {
    for (const n of [0, 7, 1536, 12 * 1024 ** 2, 5 * 1024 ** 4]) {
      expect(archiveBytes(n)).toBe(formatSizeCompact(n))
      expect(migrationBytes(n)).toBe(formatSizeCompact(n))
    }
  })
})

describe('formatBytes units', () => {
  it('stops at GB unless a larger maxUnit is asked for', () => {
    expect(formatBytes(2048 * 1024 ** 3)).toBe('2048.0 GB')
    expect(formatBytes(2048 * 1024 ** 3, { maxUnit: 'TB' })).toBe('2.0 TB')
  })

  it('keeps the system monitor and memory page labels', () => {
    expect(monitorBytes(1536)).toBe('1.5 KB')
    expect(monitorBytes(0)).toBe('0 B')
    expect(monitorBytes(3 * 1024 ** 5)).toBe('3.0 PB')
    expect(memoryBytes(512)).toBe('512 B')
    expect(memoryBytes(2048)).toBe('2.0 KB')
    expect(memoryBytes(5 * 1024 ** 3)).toBe('5120.0 MB')
  })
})
