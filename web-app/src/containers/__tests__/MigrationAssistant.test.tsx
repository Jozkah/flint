import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/lib/migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/migration')>()
  return {
    ...actual,
    migrationDetect: vi.fn(),
    migrationPlan: vi.fn(),
    migrationExecute: vi.fn(),
    migrationRollback: vi.fn(),
    migrationDismiss: vi.fn(),
    migrationStatus: vi.fn(),
  }
})

// Passthrough dialog so the wizard body renders inline (no portal/animation).
vi.mock('@/components/ui/dialog', () => {
  const Pass = ({ children }: any) => <div>{children}</div>
  return {
    // "mock-dismiss" stands in for Escape / outside click / the X button,
    // which all reach the component through onOpenChange(false).
    Dialog: ({ children, open, onOpenChange }: any) =>
      open ? (
        <div>
          <button onClick={() => onOpenChange?.(false)}>mock-dismiss</button>
          {children}
        </div>
      ) : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
  }
})
vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, 'aria-label': label }: any) => (
    <input
      type="checkbox"
      aria-label={label}
      checked={!!checked}
      onChange={() => onCheckedChange?.(!checked)}
    />
  ),
}))

import { MigrationAssistant } from '../MigrationAssistant'
import { useMigrationAssistant } from '@/stores/migration-assistant-store'
import * as mig from '@/lib/migration'

const detect = mig.migrationDetect as unknown as ReturnType<typeof vi.fn>
const plan = mig.migrationPlan as unknown as ReturnType<typeof vi.fn>
const execute = mig.migrationExecute as unknown as ReturnType<typeof vi.fn>

const FOUND = {
  found: true,
  first_launch_pending: false,
  legacy: {
    source: { config_dir: '/j/cfg', data_folder: '/j/data', location: 'data_folder' },
    total_size_bytes: 2048,
    schema_version: 1,
    categories: [
      { category: 'settings', size_bytes: 100, file_count: 1, status: 'ok' },
      { category: 'models', size_bytes: 2000, file_count: 3, status: 'ok' },
    ],
  },
}

const PLAN = {
  mode: 'copy',
  source_config_dir: '/j/cfg',
  source_data_folder: '/j/data',
  dest_config_dir: '/f/cfg',
  dest_data_folder: '/f/data',
  selected_categories: ['settings', 'models'],
  items: [
    { category: 'settings', name: 'settings.json', root: 'config', source: 's', destination: 'd', is_dir: false, size_bytes: 100, conflict: null },
  ],
  reuse_path: null,
  estimated_bytes: 2100,
  compatible: true,
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  useMigrationAssistant.setState({ open: false, openedManually: false })
})
afterEach(() => cleanup())

describe('MigrationAssistant', () => {
  it('drives detect → choose → review → execute to a complete result', async () => {
    detect.mockResolvedValue(FOUND)
    plan.mockResolvedValue(PLAN)
    execute.mockResolvedValue({
      status: 'complete',
      mode: 'copy',
      per_category: [{ category: 'settings', ok_count: 1, skipped_count: 0, failed_count: 0, done: true }],
      skipped: [],
      backup_path: null,
      reuse_path: null,
      quarantine_dir: null,
      manifest_path: '/f/cfg/migration_manifest.json',
      error: null,
      rolled_back: false,
    })

    render(<MigrationAssistant />)
    useMigrationAssistant.getState().openAssistant()

    // choose step
    expect(await screen.findByTestId('mode-copy')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mode-copy'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // review step
    await waitFor(() => expect(plan).toHaveBeenCalled())
    expect(await screen.findByText('Migrate')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Migrate' }))

    // result
    await waitFor(() => expect(execute).toHaveBeenCalled())
    expect(await screen.findByText('Migration complete.')).toBeInTheDocument()
  })

  it('shows a no-data state when no JAN install is found (manual open)', async () => {
    detect.mockResolvedValue({ found: false, first_launch_pending: false, legacy: null })
    render(<MigrationAssistant />)
    useMigrationAssistant.getState().openAssistant()
    expect(
      await screen.findByText(/No JAN data was found/i)
    ).toBeInTheDocument()
  })

  it('offers rollback and retry when execution fails', async () => {
    detect.mockResolvedValue(FOUND)
    plan.mockResolvedValue(PLAN)
    execute.mockResolvedValue({
      status: 'failed',
      mode: 'copy',
      per_category: [],
      skipped: [],
      backup_path: null,
      reuse_path: null,
      quarantine_dir: '/f/cfg/.quarantine',
      manifest_path: '/f/cfg/migration_manifest.json',
      error: 'disk full',
      rolled_back: false,
    })

    render(<MigrationAssistant />)
    useMigrationAssistant.getState().openAssistant()
    fireEvent.click(await screen.findByTestId('mode-copy'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate' }))

    expect(await screen.findByText('Migration did not complete.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('MigrationAssistant while a migration runs (#249)', () => {
  const FAILED = {
    status: 'failed',
    mode: 'copy',
    per_category: [],
    skipped: [],
    backup_path: null,
    reuse_path: null,
    quarantine_dir: '/f/cfg/.quarantine',
    manifest_path: '/f/cfg/migration_manifest.json',
    error: 'disk full',
    rolled_back: false,
  }

  async function startMigration() {
    let finish!: (r: unknown) => void
    detect.mockResolvedValue(FOUND)
    plan.mockResolvedValue(PLAN)
    execute.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<MigrationAssistant />)
    useMigrationAssistant.getState().openAssistant()
    fireEvent.click(await screen.findByTestId('mode-copy'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Migrate' }))
    expect(await screen.findByText(/Migrating your data/)).toBeInTheDocument()
    return (r: unknown) => finish(r)
  }

  it('cannot be dismissed while the migration is running', async () => {
    const finish = await startMigration()

    fireEvent.click(screen.getByRole('button', { name: 'mock-dismiss' }))

    expect(useMigrationAssistant.getState().open).toBe(true)
    expect(screen.getByText(/Migrating your data/)).toBeInTheDocument()

    finish(FAILED)
    expect(await screen.findByText('Migration did not complete.')).toBeInTheDocument()
  })

  it('shows the finished result and Roll back when reopened after a hidden run', async () => {
    const finish = await startMigration()

    // Any other path that hides the dialog mid-run.
    useMigrationAssistant.getState().closeAssistant()
    await waitFor(() => expect(screen.queryByText(/Migrating your data/)).toBeNull())
    finish(FAILED)
    await waitFor(() => expect(execute).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))

    useMigrationAssistant.getState().openAssistant()

    expect(await screen.findByText('Migration did not complete.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeInTheDocument()
    expect(screen.queryByTestId('mode-copy')).toBeNull()
  })
})
