import { describe, it, expect, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))

import {
  migrationDetect,
  migrationPlan,
  migrationExecute,
  migrationStatus,
  migrationRollback,
  migrationDismiss,
  formatBytes,
  ALL_CATEGORIES,
  MODE_LABELS,
  type MigrationPlan,
} from '../migration'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(undefined)
})

describe('migration client', () => {
  it('calls the six commands by their exact Tauri names', async () => {
    invoke.mockResolvedValue({ found: false, first_launch_pending: false, legacy: null })
    await migrationDetect()
    expect(invoke).toHaveBeenCalledWith('migration_detect')

    invoke.mockResolvedValue({ items: [] })
    await migrationPlan({
      selectedCategories: ['settings', 'models'],
      mode: 'copy',
      defaultConflict: 'keep_flint',
    })
    expect(invoke).toHaveBeenCalledWith('migration_plan', {
      selectedCategories: ['settings', 'models'],
      mode: 'copy',
      defaultConflict: 'keep_flint',
    })

    const plan = { mode: 'copy' } as unknown as MigrationPlan
    invoke.mockResolvedValue({ status: 'complete' })
    await migrationExecute(plan)
    expect(invoke).toHaveBeenCalledWith('migration_execute', { plan })

    invoke.mockResolvedValue(null)
    await migrationStatus()
    expect(invoke).toHaveBeenCalledWith('migration_status')

    invoke.mockResolvedValue(undefined)
    await migrationRollback()
    expect(invoke).toHaveBeenCalledWith('migration_rollback')

    await migrationDismiss()
    expect(invoke).toHaveBeenCalledWith('migration_dismiss')
  })

  it('has the four modes and every category label', () => {
    expect(Object.keys(MODE_LABELS).sort()).toEqual(
      ['copy', 'fresh', 'move', 'reuse'].sort()
    )
    expect(ALL_CATEGORIES).toContain('settings')
    expect(ALL_CATEGORIES).toContain('models')
    expect(ALL_CATEGORIES.length).toBe(6)
  })

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(-1)).toBe('0 B')
  })
})
