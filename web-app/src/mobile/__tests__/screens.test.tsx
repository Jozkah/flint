import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { Shell } from '../shell/Shell'
import { App } from '../App'
import { memoryPairingStore } from '../api/storage'
import { app, handleEvent, openDrawer } from '../state/app'
import type { Route } from '../state/router'
import { resetApp, useFixtures } from './helpers'

function show(route: Route) {
  resetApp(route)
  return render(<Shell />)
}

const T = { timeout: 3000 }

describe('phone screens (mocked RPC)', () => {
  let client: ReturnType<typeof useFixtures>
  beforeEach(() => {
    client = useFixtures()
  })

  it('Home shows what is waiting and starts a chat through chat.send without guessing a model', async () => {
    show({ name: 'home' })
    expect(await screen.findByText('1 approval waiting', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Changelog wording is waiting for you')).toBeInTheDocument()
    expect(await screen.findByTestId('approvals-pill')).toHaveTextContent('1')
    fireEvent.click(screen.getByText('Explain this error message'))
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }))
    expect(await screen.findByText('Sending from the phone comes in a later update', {}, T)).toBeInTheDocument()
    expect(client.rpc).toHaveBeenCalledWith(
      'chat.send',
      expect.not.objectContaining({ model: expect.anything() })
    )
    expect(client.rpc).toHaveBeenCalledWith('chat.send', expect.objectContaining({ text: 'Explain this error message', new: true }))
  })

  it('Chat renders the thread', async () => {
    show({ name: 'chat', id: 'c1' })
    expect(await screen.findByText(/The cache key is built from the region only/, {}, T)).toBeInTheDocument()
    expect(screen.getByText('Do the build ID one. Just show me the diff.')).toBeInTheDocument()
  })

  it.each([
    ['chat', 'c1', 'chat.send'],
    ['cowork', 'w1', 'cowork.send'],
  ] as const)('steers a running %s from the phone', async (name, id, method) => {
    client = useFixtures({ [method]: { kind: name, id, delivery: 'steered' } })
    show({ name, id })
    const steer = await screen.findByLabelText('Steer active run', {}, T)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Use the other approach' } })
    fireEvent.click(steer)
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith(method,
      expect.objectContaining({ id, text: 'Use the other approach', steer: true })))
  })

  it('Chat renders system/tool messages and can load older history', async () => {
    client = useFixtures({
      'thread.messages': {
        c1: {
          messages: [
            { id: 's1', role: 'system', text: 'System context', createdAt: 3 },
            { id: 't1', role: 'tool', text: 'Tool output', createdAt: 4 },
          ],
          start: 2,
          total: 4,
        },
      },
    })
    show({ name: 'chat', id: 'c1' })
    expect(await screen.findByText('System context', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Tool output')).toBeInTheDocument()
    const previous = client.rpc.getMockImplementation()
    client.rpc.mockImplementation(async (method, params) => {
      if (method === 'thread.messages' && (params as { before?: number }).before === 2) {
        return {
          messages: [
            { id: 'u0', role: 'user', text: 'Old question', createdAt: 1 },
            { id: 'a0', role: 'assistant', text: 'Old answer', createdAt: 2 },
          ],
          start: 0,
          total: 4,
        } as never
      }
      if (previous) return previous(method, params)
      throw new Error(`Unexpected ${method}`)
    })
    fireEvent.click(screen.getByRole('button', { name: /Load 2 earlier messages/ }))
    expect(await screen.findByText('Old question', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Old answer')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /earlier message/ })).toBeNull()
  })

  it('Cowork shows the tool timeline, the approval card and the plan', async () => {
    show({ name: 'cowork', id: 'w1' })
    expect(await screen.findByText('Used read', {}, T)).toBeInTheDocument()
    expect(screen.getByText('bash failed')).toBeInTheDocument()
    const step = screen.getByText('Used read').closest('[data-testid="tool-step"]')!
    expect(step).toHaveAttribute('data-tool-kind', 'read')
    expect(within(step as HTMLElement).getByText('Workspace')).toBeInTheDocument()
    const card = await screen.findByTestId('approval-card')
    expect(within(card).getByText('git push -u origin flint/radar-retry && gh pr create --fill')).toBeInTheDocument()
    expect(screen.getAllByText('3 of 5 done').length).toBeGreaterThan(0)
    client.rpc.mockImplementationOnce(async () => ({ status: 'answered' }))
    fireEvent.keyDown(
      within(card).getByRole('slider', { name: 'Allow once' }),
      { key: 'End' }
    )
    expect(
      (await screen.findAllByText('Allowed once · from this phone', {}, T))
        .length
    ).toBeGreaterThan(0)
    expect(client.rpc).toHaveBeenCalledWith('approvals.respond', {
      requestId: 'ap1',
      decision: 'allow',
      scope: 'once',
    })
  })

  it('Room shows usage, the speaker and the discussion', async () => {
    show({ name: 'room', id: 'r1' })
    expect(await screen.findByText('GPT is speaking', {}, T)).toBeInTheDocument()
    expect(screen.getByText('14 / 40')).toBeInTheDocument()
    expect(screen.getByText(/2.4% of radar fetches timed out/)).toBeInTheDocument()
  })

  it.each([
    [{ name: 'rooms' }, 'Sensor calibration check'],
    [{ name: 'overview' }, 'Agent Runs'],
    [{ name: 'library' }, 'radar-cache'],
    [{ name: 'models' }, 'Gemma 3 12B'],
    [{ name: 'tools' }, 'filesystem'],
    [{ name: 'system' }, /Windows 11 · NVIDIA RTX 4070/],
    [{ name: 'notifications' }, 'Approval waiting'],
    [{ name: 'settings' }, 'Reasoning & thinking'],
    [{ name: 'remote' }, 'Unpair this phone'],
    [{ name: 'settings-sub', sub: 'jev' }, 'Jev decision support'],
    [{ name: 'settings-sub', sub: 'localapi' }, '1337'],
  ] as [Route, string | RegExp][])('%o renders', async (route, text) => {
    show(route)
    expect((await screen.findAllByText(text, {}, T))[0]).toBeInTheDocument()
  })

  it('the left drawer lists conversations and the connection card', async () => {
    show({ name: 'home' })
    openDrawer('left')
    const nav = screen.getByRole('navigation', { hidden: true })
    expect(await within(nav).findByText('Retry the radar feed', {}, T)).toBeInTheDocument()
    expect(within(nav).getByText('Lisbon packing list')).toBeInTheDocument()
    expect(within(nav).getByTestId('connection-card')).toHaveTextContent('Desk PC')
    expect(within(nav).getByTestId('connection-card')).toHaveTextContent('3 models loaded')
  })

  it('the right panel shows a Cowork session’s progress', async () => {
    show({ name: 'cowork', id: 'w1' })
    openDrawer('right', 'progress')
    expect(await screen.findByText('Push branch and open PR', {}, T)).toBeInTheDocument()
  })

  it('events raise a banner and a notice', async () => {
    show({ name: 'home' })
    handleEvent({ type: 'approval.requested', requestId: 'ap2', toolName: 'edit', threadId: 'w2' })
    expect(await screen.findByText('Flint wants to use edit', {}, T)).toBeInTheDocument()
    expect(app.get().notices[0]).toMatchObject({ kind: 'approval', requestId: 'ap2', unread: true })
  })
})

describe('App gate', () => {
  it('shows the unpaired screen', async () => {
    useFixtures()
    resetApp()
    app.set({ auth: 'unpaired' })
    render(<App client={useFixtures()} store={memoryPairingStore()} />)
    expect(screen.getByTestId('unpaired')).toHaveTextContent("This phone isn't paired")
  })
})
