import { act, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  kick: vi.fn(async () => ({ started: [], blocked: [] })),
  transition: vi.fn(async () => ({})),
}))

vi.mock('@/lib/campaignApi', () => ({
  campaignApi: {
    list: mocks.list,
    listWithSkipped: async () => ({ campaigns: await mocks.list(), skipped: [] }),
    skipped: vi.fn().mockResolvedValue([]),
    refresh: vi.fn(),
    transition: mocks.transition,
  },
}))
// the host only asks for campaigns when there is a backend to ask
vi.mock('@/lib/platform/utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/platform/utils')>()),
  isPlatformTauri: () => true,
}))
vi.mock('@/lib/campaignHost', () => ({
  getCampaignRunner: () => ({ kick: mocks.kick }),
}))
vi.mock('@/containers/SplitConversation', () => ({
  CoworkPane: () => null,
}))

import { CampaignRunHost } from '../CampaignRunHost'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCampaignStore } from '@/hooks/useCampaigns'
import { useHostedSessions } from '@/lib/coworkHosting'

const campaigns = (over: Record<string, unknown> = {}) => [
  {
    id: 'c1',
    status: 'running',
    tasks: [{ id: 't1', status: 'running', sessionId: 's1', dependsOn: [] }],
    ...over,
  },
]

const Pane = ({ sessionId }: { sessionId: string }) => (
  <div data-testid={`pane-${sessionId}`} />
)

async function mount(list: unknown[]) {
  mocks.list.mockResolvedValue(list)
  let r!: ReturnType<typeof render>
  await act(async () => {
    r = render(<CampaignRunHost renderPane={Pane as never} />)
  })
  return r
}

describe('CampaignRunHost', () => {
  beforeEach(() => {
    useCoworkSessions.setState({
      sessions: [{ id: 's1', title: 't', turns: [], messages: [] } as never],
    })
    useCampaignStore.setState({ campaigns: [], loaded: false })
    useHostedSessions.setState({ counts: {} })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hosts a running task without any cowork route mounted', async () => {
    await mount(campaigns())
    expect(screen.getByTestId('pane-s1')).toBeTruthy()
  })

  it('does not host a server-driven campaign', async () => {
    await mount(campaigns({ driver: 'server' }))
    expect(screen.queryByTestId('pane-s1')).toBeNull()
  })

  it('yields to a visible page and takes over again when it leaves', async () => {
    await mount(campaigns())
    expect(screen.getByTestId('pane-s1')).toBeTruthy()
    act(() => useHostedSessions.getState().add('s1'))
    expect(screen.queryByTestId('pane-s1')).toBeNull()
    act(() => useHostedSessions.getState().remove('s1'))
    expect(screen.getByTestId('pane-s1')).toBeTruthy()
  })

  it('stops hosting when the task settles', async () => {
    await mount(campaigns())
    act(() =>
      useCampaignStore.setState({
        campaigns: campaigns({
          tasks: [{ id: 't1', status: 'completed', sessionId: 's1' }],
        }) as never,
      })
    )
    expect(screen.queryByTestId('pane-s1')).toBeNull()
  })

  it('unmounts its pages with the host', async () => {
    const r = await mount(campaigns())
    r.unmount()
    expect(screen.queryByTestId('pane-s1')).toBeNull()
  })
})
