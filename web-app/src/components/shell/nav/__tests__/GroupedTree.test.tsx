import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/components/shell/nav-kit', async (orig) => ({
  ...(await orig<typeof import('@/components/shell/nav-kit')>()),
  useShellNav: () => ({ isMobile: false }),
}))

import { GroupedTree } from '../GroupedTree'
import { configureGroups, useConversationGroups } from '@/lib/groups/store'
import { emptyGroupsState } from '@/lib/groups/domain'
import type { FolderAdapter } from '@/lib/groups/inherit'

const adapter: FolderAdapter = {
  attached: async () => [],
  attach: async (_id, paths) => paths,
  detach: async () => {},
}

const store = () => useConversationGroups.getState()

function tree(onNewInGroup = vi.fn()) {
  return render(
    <ul>
      <GroupedTree
        surface="cowork"
        ids={['s1', 's2', 's3']}
        renderItem={(id) => <li key={id}>{`Session ${id}`}</li>}
        keepVisible={(id) => id === 's1'}
        adapter={adapter}
        onNewInGroup={onNewInGroup}
        newInLabelKey="common:groups.newSessionIn"
        showNewGroup
      />
    </ul>
  )
}

let n = 0
beforeEach(() => {
  n = 0
  configureGroups({
    port: { load: async () => null, save: async () => {} },
    emit: () => {},
    now: () => 1000,
    newId: () => `g${n++}`,
  })
  useConversationGroups.setState({
    state: emptyGroupsState(),
    loaded: { home: true, cowork: true, rooms: true },
    migratedProjects: false,
  })
})

describe('Cowork and Rooms groups on the sidebar', () => {
  it('without groups, lists the items plainly under a New group row', () => {
    tree()
    expect(screen.getByTestId('cowork-new-group')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-group')).toBeNull()
    expect(screen.queryByTestId('nav-ungrouped')).toBeNull()
    expect(screen.getByText('Session s2')).toBeInTheDocument()
  })

  it('lists group members under their group and the rest under Ungrouped', async () => {
    await act(async () => {
      const g = (await store().createGroup('cowork', 'Backend'))!
      await store().moveItem('cowork', 's2', g)
    })
    tree()
    const group = screen.getByTestId('nav-group')
    expect(within(group).getByText('Backend')).toBeInTheDocument()
    expect(within(group).getByText('Session s2')).toBeInTheDocument()
    const rest = screen.getByTestId('nav-ungrouped')
    expect(within(rest).getByText('Session s1')).toBeInTheDocument()
    expect(within(rest).getByText('Session s3')).toBeInTheDocument()
  })

  it('collapsing a group is saved and hides all but the kept items', async () => {
    await act(async () => {
      const g = (await store().createGroup('cowork', 'Backend'))!
      await store().moveItem('cowork', 's1', g)
      await store().moveItem('cowork', 's2', g)
    })
    tree()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Backend/ }))
    })
    expect(store().state.surfaces.cowork.groups[0].collapsed).toBe(true)
    const group = screen.getByTestId('nav-group')
    expect(within(group).getByText('Session s1')).toBeInTheDocument()
    expect(within(group).queryByText('Session s2')).toBeNull()
  })

  it("the group's + starts a new item in it", async () => {
    let id = ''
    await act(async () => {
      id = (await store().createGroup('cowork', 'Backend'))!
    })
    const onNew = vi.fn()
    tree(onNew)
    fireEvent.click(screen.getByTestId('group-new-item'))
    expect(onNew).toHaveBeenCalledWith(id)
  })
})
