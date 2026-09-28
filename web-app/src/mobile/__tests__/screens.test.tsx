import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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

  it('Home shows what is waiting and starts a chat through chat.send', async () => {
    show({ name: 'home' })
    expect(await screen.findByText('1 approval waiting', {}, T)).toBeInTheDocument()
    expect(screen.getByText('Changelog wording is waiting for you')).toBeInTheDocument()
    expect(await screen.findByTestId('approvals-pill')).toHaveTextContent('1')
    fireEvent.click(screen.getByText('Explain this error message'))
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }))
    // Sending needs phase 3: the refusal is shown, not a fake reply.
    expect(await screen.findByText('Sending from the phone comes in a later update', {}, T)).toBeInTheDocument()
    expect(client.rpc).toHaveBeenCalledWith('chat.send', expect.objectContaining({ text: 'Explain this error message' }))
  })

  it('Chat renders the thread', async () => {
    show({ name: 'chat', id: 'c1' })
    expect(await screen.findByText(/The cache key is built from the region only/, {}, T)).toBeInTheDocument()
    expect(screen.getByText('Do the build ID one. Just show me the diff.')).toBeInTheDocument()
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
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    expect(await screen.findByText('Answering approvals from the phone comes in a later update', {}, T)).toBeInTheDocument()
    expect(client.rpc).toHaveBeenCalledWith('approvals.respond', { requestId: 'ap1', decision: 'allow', scope: 'once' })
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
    [{ name: 'library' }, /Artifacts open on the computer/],
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
