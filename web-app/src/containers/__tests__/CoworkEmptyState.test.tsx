import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts?.folder ? `${k}[${opts.folder}]` : k,
  }),
}))

const vaultState = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/obsidianVault', () => ({
  useObsidianVault: () => vaultState.value,
}))

import { CoworkEmptyState } from '../CoworkEmptyState'

describe('CoworkEmptyState', () => {
  it('offers workspace examples when no folder is attached', () => {
    render(<CoworkEmptyState folder={null} onPick={vi.fn()} />)

    expect(
      screen.getByText('common:coworkEmpty.subtitleSandbox')
    ).toBeInTheDocument()
    expect(
      screen.getByText('common:coworkEmpty.sandbox.first')
    ).toBeInTheDocument()
    expect(screen.queryByText(/coworkEmpty\.folder\./)).toBeNull()
  })

  // The reason the examples exist: a fixed list is wallpaper, one naming the
  // folder you just attached is a task you might actually run.
  it('names the attached folder in every example', () => {
    render(
      <CoworkEmptyState folder="/home/u/Projects/jan-app" onPick={vi.fn()} />
    )

    expect(
      screen.getByText('common:coworkEmpty.subtitleFolder[jan-app]')
    ).toBeInTheDocument()
    for (const key of ['first', 'second', 'third']) {
      expect(
        screen.getByText(`common:coworkEmpty.folder.${key}[jan-app]`)
      ).toBeInTheDocument()
    }
  })

  // The hero must not promise read-only while the composer says Edit (C-010).
  it('says what the session may do to the folder', () => {
    const { rerender } = render(
      <CoworkEmptyState folder="/p/repo" access="edit-folder" onPick={vi.fn()} />
    )
    expect(screen.getByText('common:coworkEmpty.subtitleFolderEdit[repo]')).toBeInTheDocument()
    rerender(<CoworkEmptyState folder="/p/repo" access="managed-worktree" onPick={vi.fn()} />)
    expect(screen.getByText('common:coworkEmpty.subtitleFolderWorktree[repo]')).toBeInTheDocument()
    rerender(<CoworkEmptyState folder="/p/repo" access="review-only" onPick={vi.fn()} />)
    expect(screen.getByText('common:coworkEmpty.subtitleFolder[repo]')).toBeInTheDocument()
  })

  // Loaded, not sent: an example is a starting point the user edits.
  it('loads a picked example rather than submitting it', async () => {
    const onPick = vi.fn()
    render(<CoworkEmptyState folder={null} onPick={onPick} />)

    await userEvent.click(screen.getByText('common:coworkEmpty.sandbox.second'))
    expect(onPick).toHaveBeenCalledWith('common:coworkEmpty.sandbox.second')
  })

  it('badges an Obsidian vault and says nothing for a plain folder', () => {
    vaultState.value = true
    const { unmount } = render(
      <CoworkEmptyState folder="/notes/Vault" onPick={vi.fn()} />
    )
    expect(screen.getByTestId('obsidian-vault-badge')).toHaveTextContent(
      'common:coworkEmpty.vault.badge'
    )
    unmount()
    vaultState.value = false
    render(<CoworkEmptyState folder="/notes/Plain" onPick={vi.fn()} />)
    expect(screen.queryByTestId('obsidian-vault-badge')).toBeNull()
  })

  it('offers "add my vault" only while no folder is attached', async () => {
    const onAttachFolder = vi.fn()
    const { unmount } = render(
      <CoworkEmptyState folder={null} onPick={vi.fn()} onAttachFolder={onAttachFolder} />
    )
    await userEvent.click(screen.getByTestId('cowork-add-vault'))
    expect(onAttachFolder).toHaveBeenCalledTimes(1)
    unmount()
    render(
      <CoworkEmptyState folder="/p" onPick={vi.fn()} onAttachFolder={onAttachFolder} />
    )
    expect(screen.queryByTestId('cowork-add-vault')).toBeNull()
  })
})
