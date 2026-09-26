import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { GroupFoldersDialog } from '../GroupFoldersDialog'
import type { ConversationGroup, GroupSurface } from '@/lib/groups/types'

const group = (surface: GroupSurface): ConversationGroup => ({
  id: 'g1',
  surface,
  name: 'Work',
  position: 0,
  collapsed: false,
  folderBindings: [],
  createdAt: 0,
  updatedAt: 0,
})

describe('the group folders dialog', () => {
  it.each([
    ['home', 'common:groups.foldersBodyHome'],
    ['cowork', 'common:groups.foldersBodyCowork'],
    ['rooms', 'common:groups.foldersBodyRooms'],
  ] as const)('on %s it describes what that surface does with them', (surface, key) => {
    render(
      <GroupFoldersDialog surface={surface} group={group(surface)} open onOpenChange={() => {}} />
    )
    expect(screen.getByText(key)).toBeInTheDocument()
  })
})
