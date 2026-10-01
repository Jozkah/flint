import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }

const branched = {
  start: 0,
  total: 2,
  messages: [
    { id: 'q1', role: 'user', text: 'Hello there', createdAt: 1 },
    {
      id: 'r2',
      role: 'assistant',
      text: 'Second answer',
      createdAt: 2,
      versions: { index: 2, count: 3 },
    },
  ],
}
const plain = {
  start: 0,
  total: 2,
  messages: [
    { id: 'q1', role: 'user', text: 'Hello there', createdAt: 1 },
    { id: 'r1', role: 'assistant', text: 'Only answer', createdAt: 2 },
  ],
}

describe('phone: message versions', () => {
  beforeEach(() => {
    resetApp({ name: 'chat', id: 'c1' })
  })

  it('shows the position and steps a version through thread.branch.select', async () => {
    const client = useFixtures({
      'thread.messages': { c1: branched },
      'thread.branch.select': { ok: true },
    })
    render(<Shell />)
    const nav = await screen.findByTestId('version-nav', {}, T)
    expect(within(nav).getByText('2/3')).toBeInTheDocument()
    expect(within(nav).getByLabelText('Version 2 of 3')).toBeInTheDocument()
    fireEvent.click(within(nav).getByRole('button', { name: /^Previous version/ }))
    await screen.findByTestId('version-nav', {}, T)
    expect(client.rpc).toHaveBeenCalledWith('thread.branch.select', {
      id: 'c1',
      messageId: 'r2',
      dir: -1,
    })
  })

  it('says so when the computer would not switch', async () => {
    useFixtures({
      'thread.messages': { c1: branched },
      'thread.branch.select': { ok: false },
    })
    render(<Shell />)
    const nav = await screen.findByTestId('version-nav', {}, T)
    fireEvent.click(within(nav).getByRole('button', { name: /^Next version/ }))
    expect(
      await screen.findByText('Wait for the reply to finish, then try again.', {}, T)
    ).toBeInTheDocument()
  })

  it('shows nothing for a message with one version (and for an older computer)', async () => {
    useFixtures({ 'thread.messages': { c1: plain } })
    render(<Shell />)
    await screen.findByText('Only answer', {}, T)
    expect(screen.queryByTestId('version-nav')).toBeNull()
  })
})
