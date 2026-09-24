import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { SidebarProvider, SidebarMenuItem } from '@/components/ui/sidebar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { GroupedNav } from '../GroupedNav'
import { MoveToGroupMenu } from '../MoveToGroupMenu'
import { GroupAnnouncer } from '../GroupAnnouncer'
import { configureGroups, useConversationGroups } from '@/lib/groups/store'
import { emptyGroupsState } from '@/lib/groups/domain'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import type { GroupFolderBinding, GroupSurface } from '@/lib/groups/types'

type Item = { id: string; title: string; folder?: string }

let saved: Partial<Record<GroupSurface, string>>
let n = 0

beforeEach(() => {
  saved = {}
  n = 0
  configureGroups({
    port: { load: async (s) => saved[s] ?? null, save: async (s, raw) => void (saved[s] = raw) },
    emit: () => {},
    now: () => 1,
    newId: () => `g${n++}`,
  })
  useConversationGroups.setState({
    state: emptyGroupsState(),
    loaded: { home: true, cowork: true, rooms: true },
  })
  useLeftPanel.setState({ groupsCompact: false })
  // Announcements clear then set on the next frame.
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 0
  })
})

const items = (count = 3): Item[] =>
  Array.from({ length: count }, (_, i) => ({ id: `i${i}`, title: `Item ${i}` }))

function Row({ item, row }: { item: Item; row: Parameters<Parameters<typeof GroupedNav<Item>>[0]['renderItem']>[1] }) {
  return (
    <SidebarMenuItem {...row} data-testid={`row-${item.id}`} tabIndex={0}>
      <span>{item.title}</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`menu ${item.id}`}>…</DropdownMenuTrigger>
        <DropdownMenuContent>
          <MoveToGroupMenu itemId={item.id} />
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

function renderNav(
  list: Item[],
  opts: {
    surface?: GroupSurface
    active?: string[]
    ownFolders?: (i: Item) => GroupFolderBinding[]
    selectedId?: string
  } = {}
) {
  return render(
    <SidebarProvider>
      <GroupAnnouncer />
      <GroupedNav<Item>
        surface={opts.surface ?? 'cowork'}
        items={list}
        getId={(i) => i.id}
        getLabel={(i) => i.title}
        activeIds={new Set(opts.active ?? [])}
        recentsLabel="Recents"
        selectedId={opts.selectedId}
        ownFoldersOf={opts.ownFolders}
        renderItem={(item, row) => <Row key={item.id} item={item} row={row} />}
      />
    </SidebarProvider>
  )
}

/** Radix menu items select on keyboard in jsdom; pointer clicks are swallowed. */
async function choose(user: ReturnType<typeof userEvent.setup>, el: HTMLElement) {
  el.focus()
  await user.keyboard('{Enter}')
}

const groups = (s: GroupSurface = 'cowork') => useConversationGroups.getState().state.surfaces[s]
const announcer = () => screen.getByTestId('group-announcer')

async function makeGroup(name: string, s: GroupSurface = 'cowork', folders?: GroupFolderBinding[]) {
  let id: string | null = null
  await act(async () => {
    id = await useConversationGroups.getState().createGroup(s, name, { folderBindings: folders })
  })
  return id!
}

describe('GroupedNav', () => {
  it('shows empty groups and Recents in recent-activity order', async () => {
    await makeGroup('Alpha')
    renderNav(items())
    expect(screen.getByRole('button', { name: /Alpha, 0 items/ })).toBeInTheDocument()
    expect(screen.getByText('Drag items here or use Move to group')).toBeInTheDocument()
    const recents = screen.getByRole('list', { name: 'Recents' })
    expect(within(recents).getAllByText(/Item/).map((e) => e.textContent)).toEqual(['Item 0', 'Item 1', 'Item 2'])
  })

  it('creates a group and renames inline: Enter saves, Escape cancels', async () => {
    const user = userEvent.setup()
    renderNav(items())
    await user.click(screen.getByTestId('groups-cowork-new'))
    const input = await screen.findByTestId('group-rename-input')
    await user.clear(input)
    await user.type(input, 'Research{Enter}')
    expect(groups().groups[0].name).toBe('Research')

    fireEvent.keyDown(screen.getByTestId(`group-row-${groups().groups[0].id}`), { key: 'F2' })
    const again = await screen.findByTestId('group-rename-input')
    await user.clear(again)
    await user.type(again, 'Nope{Escape}')
    expect(groups().groups[0].name).toBe('Research')
  })

  it('collapses and expands with persisted state and announcements', async () => {
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i0', g))
    renderNav(items())
    const row = screen.getByTestId(`group-row-${g}`)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    await act(async () => fireEvent.click(row))
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(groups().groups[0].collapsed).toBe(true)
    expect(JSON.parse(saved.cowork!).data.groups[0].collapsed).toBe(true)
    expect(screen.queryByTestId('row-i0')).not.toBeInTheDocument()
    await waitFor(() => expect(announcer()).toHaveTextContent('Alpha collapsed'))
  })

  it('marks a collapsed group active when a hidden child runs, with a text label', async () => {
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i1', g))
    await act(() => useConversationGroups.getState().setCollapsed('cowork', g, true))
    renderNav(items(), { active: ['i1'] })
    expect(screen.getByRole('img', { name: '1 active in Alpha' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Alpha, 1 item, 1 active, collapsed/ })).toBeInTheDocument()
  })

  it('reorders groups with Alt+Arrow keys and announces the position', async () => {
    await makeGroup('One')
    const two = await makeGroup('Two')
    renderNav(items())
    await act(async () => fireEvent.keyDown(screen.getByTestId(`group-row-${two}`), { key: 'ArrowUp', altKey: true }))
    expect([...groups().groups].sort((a, b) => a.position - b.position).map((g) => g.name)).toEqual(['Two', 'One'])
    await waitFor(() => expect(announcer()).toHaveTextContent('Two moved to position 1 of 2'))
  })

  it('reorders children with Alt+Arrow keys', async () => {
    const g = await makeGroup('Alpha')
    for (const id of ['i0', 'i1']) await act(() => useConversationGroups.getState().moveItem('cowork', id, g))
    renderNav(items())
    await act(async () => fireEvent.keyDown(screen.getByTestId('row-i1'), { key: 'ArrowUp', altKey: true }))
    expect(groups().memberships.i1.position).toBe(0)
    await waitFor(() => expect(announcer()).toHaveTextContent('Moved to Alpha, position 1'))
  })

  it('moves an item through the menu and back to Recents', async () => {
    const user = userEvent.setup()
    await makeGroup('Alpha')
    renderNav(items())
    await user.click(screen.getByRole('button', { name: 'menu i2' }))
    await user.click(await screen.findByText('Move to group'))
    await choose(user, await screen.findByRole('menuitem', { name: 'Alpha' }))
    await waitFor(() => expect(groups().memberships.i2?.groupId).toBe(groups().groups[0].id))
    await user.click(screen.getByRole('button', { name: 'menu i2' }))
    await choose(user, await screen.findByRole('menuitem', { name: 'Move to Recents' }))
    await waitFor(() => expect(groups().memberships.i2).toBeUndefined())
  })

  it('asks before deleting a non-empty group and keeps its items', async () => {
    const user = userEvent.setup()
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i0', g))
    renderNav(items())
    await user.click(screen.getByRole('button', { name: 'Group actions for Alpha' }))
    await choose(user, await screen.findByRole('menuitem', { name: /Delete group/ }))
    expect(screen.getByText(/Its items move to Recents/)).toBeInTheDocument()
    await user.click(screen.getByTestId('confirm-delete-group'))
    expect(groups().groups).toHaveLength(0)
    expect(within(screen.getByRole('list', { name: 'Recents' })).getByText('Item 0')).toBeInTheDocument()
  })

  it('compact mode shows identity, count and state without expanding', async () => {
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i0', g))
    useLeftPanel.setState({ groupsCompact: true })
    renderNav(items(), { active: ['i0'] })
    expect(screen.queryByTestId('row-i0')).not.toBeInTheDocument()
    const row = screen.getByTestId(`group-row-${g}`)
    expect(row).toHaveAccessibleName(/Alpha, 1 item, 1 active, collapsed/)
    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(groups().groups[0].collapsed).toBe(false)
    await act(async () => fireEvent.click(row))
    expect(screen.getByTestId('row-i0')).toBeInTheDocument()
    expect(groups().groups[0].collapsed).toBe(false)
  })

  it('reveals a collapsed group for a navigated item without persisting expansion', async () => {
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i0', g))
    await act(() => useConversationGroups.getState().setCollapsed('cowork', g, true))
    renderNav(items(), { selectedId: 'i0' })
    expect(screen.getByTestId('row-i0')).toBeInTheDocument()
    expect(screen.getByTestId(`group-row-${g}`)).toHaveAttribute('aria-expanded', 'true')
    expect(groups().groups[0].collapsed).toBe(true)
  })

  it('collapses an expanded group that holds the selected item when the user asks', async () => {
    const g = await makeGroup('Alpha')
    await act(() => useConversationGroups.getState().moveItem('cowork', 'i0', g))
    renderNav(items(), { selectedId: 'i0' })
    const row = screen.getByTestId(`group-row-${g}`)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    await act(async () => fireEvent.click(row))
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('row-i0')).not.toBeInTheDocument()
    expect(groups().groups[0].collapsed).toBe(true)
  })

  it('never offers another surface’s groups', async () => {
    const user = userEvent.setup()
    await makeGroup('Home only', 'home')
    renderNav(items())
    await user.click(screen.getByRole('button', { name: 'menu i0' }))
    await user.click(await screen.findByText('Move to group'))
    expect(screen.queryByRole('menuitem', { name: 'Home only' })).not.toBeInTheDocument()
  })

  describe('folder resolution', () => {
    const repo = { path: '/repo', canonicalPath: '/repo', displayName: 'repo' }
    const docs = { path: '/docs', canonicalPath: '/docs', displayName: 'docs' }
    const own = (i: Item) => (i.folder ? [{ path: i.folder, canonicalPath: i.folder, displayName: i.folder.slice(1) }] : [])
    const list = [{ id: 'i0', title: 'Item 0', folder: '/repo' }]

    async function moveViaMenu() {
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'menu i0' }))
      await user.click(await screen.findByText('Move to group'))
      await choose(user, await screen.findByRole('menuitem', { name: 'Docs' }))
      return user
    }

    it('cancel leaves membership and context unchanged', async () => {
      await makeGroup('Docs', 'cowork', [docs])
      renderNav(list, { ownFolders: own })
      const user = await moveViaMenu()
      expect(await screen.findByTestId('folder-resolution-dialog')).toBeInTheDocument()
      expect(screen.getByText('No option grants read or write access.')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(groups().memberships.i0).toBeUndefined())
      expect(groups().contexts.i0).toBeUndefined()
    })

    it.each([
      ['keep', undefined, ['docs']],
      ['inherit', 'inherit', ['docs']],
      ['merge', 'merge', ['docs']],
    ])('%s moves with the expected context', async (choice, mode, groupFolders) => {
      await makeGroup('Docs', 'cowork', [docs])
      renderNav(list, { ownFolders: own })
      const user = await moveViaMenu()
      await user.click(await screen.findByTestId(`folder-choice-${choice}`))
      await user.click(screen.getByTestId('folder-resolution-confirm'))
      await waitFor(() => expect(groups().memberships.i0).toBeDefined())
      expect(groups().contexts.i0?.mode).toBe(mode)
      expect(groups().groups[0].folderBindings.map((b) => b.displayName)).toEqual(groupFolders)
    })

    it('add item folders to group needs an explicit confirmation', async () => {
      await makeGroup('Docs', 'cowork', [docs])
      renderNav(list, { ownFolders: own })
      const user = await moveViaMenu()
      await user.click(await screen.findByTestId('folder-choice-addToGroup'))
      expect(screen.getByTestId('folder-resolution-confirm')).toBeDisabled()
      await user.click(screen.getByTestId('confirm-add-to-group'))
      await user.click(screen.getByTestId('folder-resolution-confirm'))
      await waitFor(() => expect(groups().memberships.i0).toBeDefined())
      expect(groups().groups[0].folderBindings.map((b) => b.displayName)).toEqual(['docs', 'repo'])
      expect(groups().contexts.i0).toBeUndefined()
    })

    it('skips the dialog when folders already match', async () => {
      await makeGroup('Docs', 'cowork', [repo])
      renderNav(list, { ownFolders: own })
      await moveViaMenu()
      await waitFor(() => expect(groups().memberships.i0).toBeDefined())
      expect(screen.queryByTestId('folder-resolution-dialog')).not.toBeInTheDocument()
    })
  })

  it('renders 100 groups and 2,000 items', async () => {
    let state = useConversationGroups.getState().state
    const { createGroup, moveItem } = await import('@/lib/groups/domain')
    for (let i = 0; i < 100; i++) state = createGroup(state, 'rooms', { id: `G${i}`, name: `Group ${i}`, now: 0 })
    for (let i = 0; i < 1000; i++) state = moveItem(state, 'rooms', `i${i}`, `G${i % 100}`)
    useConversationGroups.setState({ state })
    const t0 = performance.now()
    renderNav(items(2000), { surface: 'rooms' })
    const elapsed = performance.now() - t0
    expect(screen.getAllByRole('button', { name: /^Group \d+,/ })).toHaveLength(100)
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2000)
    // Generous for CI jsdom; the real bound is visual smoothness in the app.
    expect(elapsed).toBeLessThan(15000)
  })
})
