import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { GroupPrompts } from '../GroupPrompts'
import { useKeepFoldersPrompt } from '@/lib/groups/keepPrompt'
import type { ConversationGroup } from '@/lib/groups/types'

const group: ConversationGroup = {
  id: 'g1',
  surface: 'home',
  name: 'Work',
  position: 0,
  collapsed: false,
  folderBindings: [{ path: '/web', canonicalPath: '/web', displayName: 'web' }],
  createdAt: 0,
  updatedAt: 0,
}

describe('group folder prompts', () => {
  it('the join dialog answers with the chosen option', async () => {
    render(<GroupPrompts surface="home" />)
    let answer: Promise<string>
    act(() => {
      answer = useKeepFoldersPrompt.getState().askJoin('home', ['/own'], group)
    })
    expect(screen.getByTestId('group-join-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('folder-choice-inherit'))
    fireEvent.click(screen.getByTestId('group-join-confirm'))
    await expect(answer!).resolves.toBe('inherit')
  })

  it("another surface's question is not shown here", () => {
    render(<GroupPrompts surface="rooms" />)
    act(() => {
      void useKeepFoldersPrompt.getState().askJoin('home', ['/own'], group)
    })
    expect(screen.queryByTestId('group-join-dialog')).toBeNull()
    act(() => useKeepFoldersPrompt.getState().answerJoin('cancel'))
  })

  it('leaving asks to keep or detach', async () => {
    render(<GroupPrompts surface="home" />)
    let keep: Promise<boolean>
    act(() => {
      keep = useKeepFoldersPrompt.getState().ask('home', 'Work', ['/web'])
    })
    fireEvent.click(screen.getByTestId('group-detach-folders'))
    await expect(keep!).resolves.toBe(false)
  })
})
