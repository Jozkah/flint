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

  // One quiet chip: folder icon, name, and at most one trailing mark at rest.
  describe('the chip itself', () => {
    const chip = (access: 'review-only' | 'managed-worktree' | 'edit-folder') => {
      render(
        <CoworkWorkspacePill
          folder="/home/u/acme-weather"
          gitBranch="flint/radar-retry"
          access={access}
          variant="quiet"
          onAttach={vi.fn()}
          onDetach={vi.fn()}
        />
      )
      return screen.getByRole('button')
    }

    it('shows a worktree as a separated badge naming the branch in its tooltip', () => {
      const btn = chip('managed-worktree')
      const badge = btn.querySelector('[data-worktree-badge]')!
      expect(badge).toHaveAttribute(
        'title',
        'common:workspace.worktreeBadge flint/radar-retry'
      )
      expect(btn).not.toHaveTextContent('flint/radar-retry')
      // folder icon + fork glyph; no pencil, no branch icon
      expect(btn.querySelectorAll('svg')).toHaveLength(2)
      expect(btn.querySelector('.lucide-git-branch')).toBeNull()
    })

    it('shows the pencil of an editable folder only on hover or focus', () => {
      const btn = chip('edit-folder')
      const pencil = btn.querySelector('[data-access="editable"]')!
      expect(pencil.getAttribute('class')).toContain('opacity-0')
      expect(pencil.getAttribute('class')).toContain('group-hover/ws:opacity-100')
      expect(btn.querySelector('[data-worktree-badge]')).toBeNull()
    })

    it('is borderless and 28px tall in the quiet row', () => {
      const btn = chip('review-only')
      expect(btn.className).toContain('h-7')
      expect(btn.className).toContain('gap-2')
      expect(btn.className).not.toContain('border-[0.8px]')
    })
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

  it('does not call an editable folder read-only in its label (D4)', () => {
    render(
      <CoworkWorkspacePill folder="/home/u/p" access="edit-folder" onAttach={vi.fn()} onDetach={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: /a11yWithFolderEditable/ })).toBeInTheDocument()
  })

  it('does not promise read-only before a folder is attached in an edit mode (C-010)', async () => {
    const { unmount } = render(
      <CoworkWorkspacePill folder={null} access="edit-folder" onAttach={vi.fn()} onDetach={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yNoFolder/ }))
    expect(screen.getByText('common:workspace.footnoteEmptyEdit')).toBeInTheDocument()
    expect(screen.queryByText('common:workspace.footnoteEmpty')).toBeNull()
    unmount()
    render(<CoworkWorkspacePill folder={null} onAttach={vi.fn()} onDetach={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /a11yNoFolder/ }))
    expect(screen.getByText('common:workspace.footnoteEmpty')).toBeInTheDocument()
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
    expect(openPath).toHaveBeenCalledWith('/home/u/Projects/jan-app', ['/home/u/Projects/jan-app'])

    await userEvent.click(screen.getByText('common:workspace.reveal'))
    expect(revealItemInDir).toHaveBeenCalledWith('/home/u/Projects/jan-app', ['/home/u/Projects/jan-app'])
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

    it('shows an extra folder marked read-only as read-only under edits', async () => {
      expect(
        await open({
          access: 'edit-folder',
          extraFoldersWritable: true,
          readOnlyExtraFolders: ['c:/repo/b/'],
        })
      ).toEqual(['editable', 'read-only'])
    })

    it('toggles an extra folder from its badge when edits are allowed', async () => {
      const onToggleExtraWritable = vi.fn()
      await open({
        access: 'edit-folder',
        extraFoldersWritable: true,
        onToggleExtraWritable,
      })
      await userEvent.click(
        screen.getByRole('button', { name: /makeReadOnly/ })
      )
      expect(onToggleExtraWritable).toHaveBeenCalledWith('C:/repo/b', false)
    })

    it('toggles a read-only extra folder back to editable', async () => {
      const onToggleExtraWritable = vi.fn()
      await open({
        access: 'edit-folder',
        extraFoldersWritable: true,
        readOnlyExtraFolders: ['C:/repo/b'],
        onToggleExtraWritable,
      })
      await userEvent.click(
        screen.getByRole('button', { name: /makeEditable/ })
      )
      expect(onToggleExtraWritable).toHaveBeenCalledWith('C:/repo/b', true)
    })

    it('lets an extra folder be made editable from Review only', async () => {
      const onToggleExtraWritable = vi.fn()
      await open({
        access: 'review-only',
        extraFoldersWritable: true,
        onToggleExtraWritable,
      })
      await userEvent.click(
        screen.getByRole('button', { name: /makeEditable/ })
      )
      expect(onToggleExtraWritable).toHaveBeenCalledWith('C:/repo/b', true)
    })

    it('offers no toggle where the platform cannot grant a folder', async () => {
      await open({
        access: 'review-only',
        extraFoldersWritable: false,
        onToggleExtraWritable: vi.fn(),
        onToggleMainWritable: vi.fn(),
      })
      expect(
        screen.queryByRole('button', { name: /makeReadOnly|makeEditable/ })
      ).toBeNull()
    })

    it('toggles the main folder from its badge, like an extra', async () => {
      const onToggleMainWritable = vi.fn()
      await open({
        access: 'edit-folder',
        extraFoldersWritable: true,
        readOnlyExtraFolders: ['C:/repo/b'],
        onToggleMainWritable,
      })
      await userEvent.click(
        screen.getByRole('button', { name: /makeReadOnly/ })
      )
      expect(onToggleMainWritable).toHaveBeenCalledWith(false)
    })

    it('shows a read-only main folder beside an editable extra', async () => {
      const onToggleMainWritable = vi.fn()
      expect(
        await open({
          access: 'edit-folder',
          extraFoldersWritable: true,
          mainFolderReadOnly: true,
          onToggleMainWritable,
        })
      ).toEqual(['read-only', 'editable'])
      expect(screen.getByText('common:workspace.writesExtras')).toBeInTheDocument()
      await userEvent.click(
        screen.getByRole('button', { name: /makeEditable/ })
      )
      expect(onToggleMainWritable).toHaveBeenCalledWith(true)
    })

    it('offers no main-folder toggle in a managed worktree', async () => {
      await open({
        access: 'managed-worktree',
        extraFoldersWritable: true,
        onToggleMainWritable: vi.fn(),
      })
      expect(document.querySelector('[data-main-toggle]')).toBeNull()
    })
  })

  it('offers describing the project from the folder menu, and closes itself', async () => {
    const onOpen = vi.fn()
    render(
      <CoworkWorkspacePill
        folder="/home/u/Projects/jan-app"
        onAttach={vi.fn()}
        onDetach={vi.fn()}
        describeProject={{ label: 'Describe this project', onOpen }}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))
    await userEvent.click(screen.getByTestId('project-init-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('project-init-open')).toBeNull()
  })

  it('does not offer it when the folder already has a FLINT.md', async () => {
    render(
      <CoworkWorkspacePill folder="/home/u/Projects/jan-app" onAttach={vi.fn()} onDetach={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /a11yWithFolder/ }))
    expect(screen.queryByTestId('project-init-open')).toBeNull()
  })
})
