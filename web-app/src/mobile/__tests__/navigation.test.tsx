import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { app, back, go } from '../state/app'
import { refresh } from '../state/rpc'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }
const msg = (n: number) => ({ id: `m${n}`, role: 'user', text: `message ${n}`, createdAt: n })

describe('mobile navigation and chat paging', () => {
  beforeEach(() => {
    history.replaceState(null, '', '#/')
  })

  it('switching chats remounts the screen so a composer draft does not leak', async () => {
    useFixtures({
      'thread.messages': {
        c1: { messages: [msg(1)], start: 0, total: 1 },
        c2: { messages: [msg(2)], start: 0, total: 1 },
      },
    })
    resetApp({ name: 'chat', id: 'c1' })
    render(<Shell />)
    await screen.findByText('message 1', {}, T)
    const box = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft for chat one' } })
    expect(box.value).toBe('draft for chat one')
    act(() => app.set({ route: { name: 'chat', id: 'c2' } }))
    await screen.findByText('message 2', {}, T)
    const next = screen.getByPlaceholderText('Ask me anything...') as HTMLTextAreaElement
    expect(next.value).toBe('')
  })

  it('keeps a message that slides out of the newest window when new ones arrive', async () => {
    let window = { messages: [msg(2), msg(3)], start: 2, total: 4 }
    const client = useFixtures()
    client.rpc.mockImplementation(async (method: string) => {
      if (method === 'thread.messages') return window as never
      if (method === 'thread.queue') return { items: [] } as never
      throw new Error(`Unexpected ${method}`)
    })
    resetApp({ name: 'chat', id: 'c1' })
    render(<Shell />)
    await screen.findByText('message 3', {}, T)
    // One message arrives: the window moves to [3, 5) and message 2 falls out of it.
    window = { messages: [msg(3), msg(4)], start: 3, total: 5 }
    await act(async () => {
      await refresh(['thread.messages'])
    })
    await screen.findByText('message 4', {}, T)
    expect(screen.getByText('message 2')).toBeInTheDocument()
    expect(screen.getByText('message 3')).toBeInTheDocument()
  })

  it('back() leaves the app only when there is an in-app page to return to', () => {
    resetApp({ name: 'home' })
    const spy = vi.spyOn(history, 'back')
    // Entry page: nothing in-app before it, so Back goes home instead of leaving.
    back({ name: 'settings' })
    expect(spy).not.toHaveBeenCalled()
    expect(app.get().route.name).toBe('settings')
    // One in-app step deep: use the browser stack.
    go({ name: 'models' })
    back()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
