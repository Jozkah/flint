import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const invalidateSkills = vi.fn()
vi.mock('@/hooks/useSkills', () => ({
  invalidateSkills: () => invalidateSkills(),
}))

const ccScan = vi.fn()
const ccImport = vi.fn()
vi.mock('@/lib/extensionsStore', () => ({
  ccScan: (...a: unknown[]) => ccScan(...a),
  ccImport: (...a: unknown[]) => ccImport(...a),
}))

import ImportFromClaudeCodeDialog from '../ImportFromClaudeCodeDialog'

const manifest = {
  items: [
    {
      kind: 'skill' as const,
      name: 'brainstorming',
      sourcePath: '/home/user/.claude/skills/brainstorming',
      origin: 'Claude Code (skills)',
      alreadyExists: false,
    },
    {
      kind: 'skill' as const,
      name: 'existing-skill',
      sourcePath: '/home/user/.claude/skills/existing-skill',
      origin: 'Claude Code (skills)',
      alreadyExists: true,
    },
    {
      kind: 'plugin' as const,
      name: 'superpowers',
      sourcePath: '/home/user/.claude/plugins/superpowers',
      origin: 'Claude Code (plugins)',
      alreadyExists: false,
    },
  ],
}

beforeEach(() => {
  ccScan.mockReset()
  ccImport.mockReset()
  invalidateSkills.mockReset()
})

describe('ImportFromClaudeCodeDialog', () => {
  it('scans and renders items grouped by origin, unchecking and tagging existing ones', async () => {
    ccScan.mockResolvedValue(manifest)
    render(<ImportFromClaudeCodeDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByText('common:extensionsManager.import.scan'))

    await waitFor(() => expect(ccScan).toHaveBeenCalledWith(undefined))

    expect(screen.getByText('Claude Code (skills)')).toBeInTheDocument()
    expect(screen.getByText('Claude Code (plugins)')).toBeInTheDocument()

    const newCheckbox = screen.getByLabelText('brainstorming') as HTMLInputElement
    const existingCheckbox = screen.getByLabelText('existing-skill') as HTMLInputElement
    expect(newCheckbox.checked).toBe(true)
    expect(existingCheckbox.checked).toBe(false)

    expect(screen.getByText('common:extensionsManager.import.installed')).toBeInTheDocument()
  })

  it('imports only checked items with kind/name/sourcePath and the overwrite flag, then shows the summary', async () => {
    ccScan.mockResolvedValue(manifest)
    ccImport.mockResolvedValue({ imported: ['brainstorming'], skipped: [], errors: [] })
    render(<ImportFromClaudeCodeDialog open onOpenChange={() => {}} />)

    fireEvent.click(screen.getByText('common:extensionsManager.import.scan'))
    await waitFor(() => expect(ccScan).toHaveBeenCalled())

    // 'superpowers' is already checked by default (not alreadyExists), and
    // 'existing-skill' stays unchecked by default -- so both non-existing
    // items ('brainstorming' and 'superpowers') are selected here.
    const overwriteSwitch = screen.getByLabelText(
      'common:extensionsManager.import.overwrite'
    )
    fireEvent.click(overwriteSwitch)

    fireEvent.click(screen.getByText('common:extensionsManager.import.importSelected'))

    await waitFor(() => expect(ccImport).toHaveBeenCalled())

    expect(ccImport).toHaveBeenCalledWith(
      [
        {
          kind: 'skill',
          name: 'brainstorming',
          sourcePath: '/home/user/.claude/skills/brainstorming',
        },
        {
          kind: 'plugin',
          name: 'superpowers',
          sourcePath: '/home/user/.claude/plugins/superpowers',
        },
      ],
      true
    )

    await waitFor(() => expect(invalidateSkills).toHaveBeenCalled())
    expect(
      screen.getByText(/common:extensionsManager.import.done/)
    ).toBeInTheDocument()
  })
})
