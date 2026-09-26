import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k} ${Object.values(opts).join(' ')}` : k,
  }),
}))

const openPath = vi.fn()
const revealItemInDir = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ openPath, revealItemInDir }) }),
}))

import { CoworkWorkspacePill } from '../CoworkWorkspacePill'

describe('CoworkWorkspacePill', () => {
  beforeEach(() => {
    openPath.mockReset()
    revealItemInDir.mockReset()
  })

  it('invites attaching a folder when none is attached', async () => {
    render(
      <CoworkWorkspacePill folder={null} onAttach={vi.fn()} onDetach={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yNoFolder/ }))

    expect(screen.queryByText('common:workspace.readsFrom')).toBeNull()
    // No folder means nothing to detach.
    expect(screen.queryByText('common:workspace.detach')).toBeNull()
    expect(
      screen.getAllByText('common:workspace.attach').length
    ).toBeGreaterThan(0)
  })

  // The honesty requirement: whenever a folder is attached, the popover must
  // name the direction and mark the folder read-only. A regression here would
  // have the UI implying the agent edits the user's project.
  it('names the read direction and marks the folder read-only', async () => {
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        gitBranch="dev"
        onAttach={vi.fn()}
        onDetach={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))

    expect(screen.getByText('common:workspace.readsFrom')).toBeInTheDocument()
    expect(
      screen.getAllByText('common:workspace.readOnly').length
    ).toBeGreaterThan(0)
    expect(screen.getByText('dev')).toBeInTheDocument()
    // The read-only contract is the badge's tooltip now that the popover is
    // grouped; the badge itself carries the visible word.
    expect(
      screen.getByTitle('common:workspace.footnote')
    ).toBeInTheDocument()
  })

  // The folder is read-only and writes land in the session sandbox. Saying
  // otherwise — or saying nothing — is how a user comes to believe the agent
  // is editing their project in place.
  it('says where the agent’s changes actually go', async () => {
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        workspacePath="/var/sessions/abc"
        onAttach={vi.fn()}
        onDetach={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))

    expect(screen.getByText('common:workspace.writesTo')).toBeInTheDocument()
    expect(screen.getByText('common:workspace.sandbox')).toBeInTheDocument()
    expect(
      screen.getByText('common:workspace.sandboxNote')
    ).toBeInTheDocument()
  })

  it('says the sandbox does not exist yet before anything is written', async () => {
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        workspacePath={null}
        onAttach={vi.fn()}
        onDetach={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))

    expect(
      screen.getByText('common:workspace.sandboxPending')
    ).toBeInTheDocument()
  })

  it('keeps detaching apart from the other actions', async () => {
    const onDetach = vi.fn()
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        onAttach={vi.fn()}
        onDetach={onDetach}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))

    const detach = screen.getByRole('button', {
      name: 'common:workspace.detach',
    })
    // Destructive styling, not just position: it must not read as a peer of
    // Open and Reveal.
    expect(detach.className).toMatch(/destructive/)
    await userEvent.click(detach)
    expect(onDetach).toHaveBeenCalledTimes(1)
  })

  it('opens the folder and reveals it through the right opener calls', async () => {
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        onAttach={vi.fn()}
        onDetach={vi.fn()}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))

    await userEvent.click(screen.getAllByText('common:workspace.open')[0])
    expect(openPath).toHaveBeenCalledWith('/home/u/Projects/jan-app')

    await userEvent.click(screen.getByText('common:workspace.reveal'))
    expect(revealItemInDir).toHaveBeenCalledWith('/home/u/Projects/jan-app')
  })

  it('detaches the folder', async () => {
    const onDetach = vi.fn()
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        onAttach={vi.fn()}
        onDetach={onDetach}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))
    await userEvent.click(screen.getByText('common:workspace.detach'))
    expect(onDetach).toHaveBeenCalled()
  })

  describe('folder access badges', () => {
    const open = async (props: Record<string, unknown>) => {
      render(
        <CoworkWorkspacePill
          folder="C:/repo/a"
          extraFolders={['C:/repo/b']}
          onAttach={vi.fn()}
          onDetach={vi.fn()}
          {...props}
        />
      )
      await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))
      return Array.from(document.querySelectorAll('span[data-access]')).map(
        (el) => el.getAttribute('data-access')
      )
    }

    it('marks every folder read-only under Review only', async () => {
      expect(await open({ access: 'review-only', extraFoldersWritable: true })).toEqual([
        'read-only',
        'read-only',
      ])
      expect(screen.getByText('common:workspace.sandbox')).toBeInTheDocument()
    })

    it('marks the folders editable under Edit this folder', async () => {
      expect(await open({ access: 'edit-folder', extraFoldersWritable: true })).toEqual([
        'editable',
        'editable',
      ])
      expect(screen.queryAllByText('common:workspace.readOnly')).toHaveLength(0)
      expect(screen.getByText('common:workspace.writesFolder')).toBeInTheDocument()
    })

    it('marks the primary as a worktree and extras by the grant under Managed worktree', async () => {
      expect(await open({ access: 'managed-worktree', extraFoldersWritable: false })).toEqual([
        'worktree',
        'read-only',
      ])
      expect(screen.getByText('common:workspace.writesWorktree')).toBeInTheDocument()
    })

    it('defaults to read-only when no access is given', async () => {
      expect(await open({})).toEqual(['read-only', 'read-only'])
    })
  })
})
