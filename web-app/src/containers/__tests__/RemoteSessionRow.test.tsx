// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

import { SessionRow } from '../RemoteRunnerCard'
import type { RemoteSession } from '@/lib/remoteRunner'

const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  id: 's1',
  title: 'Weekly report',
  folder: '/srv/app',
  mode: 'cowork',
  model: 'm1',
  updated: 1,
  status: 'idle',
  campaign: null,
  access: 'ask',
  ...over,
})

const models = [
  { id: 'm1', provider: 'p', label: 'p / m1', contextWindow: 128000, supportsTools: null },
  { id: 'm2', provider: 'p', label: 'p / m2', contextWindow: 200000, supportsTools: null },
]

function stubFetch() {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => '{}',
  }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a server session row', () => {
  it('changes the model and the access through the server commands', async () => {
    const fetch = stubFetch()
    const onChanged = vi.fn()
    render(<SessionRow session={session()} info={{ allowBypass: false }} models={models} onChanged={onChanged} />)
    // Unattended access is not offered when the operator did not allow it.
    const access = screen.getByLabelText('Access') as HTMLSelectElement
    expect([...access.options].map((o) => o.value)).toEqual(['read', 'ask'])
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'm2' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    fireEvent.change(access, { target: { value: 'read' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
    const calls = fetch.mock.calls.map((c) => [c[0], JSON.parse((c[1] as RequestInit).body as string)])
    expect(calls).toEqual([
      ['/api/v1/rpc/agent_run_set_model', { id: 's1', model: 'm2' }],
      ['/api/v1/rpc/agent_run_set_mode', { id: 's1', access: 'read' }],
    ])
  })

  it('deletes only after a confirmation', async () => {
    const fetch = stubFetch()
    const onChanged = vi.fn()
    const confirm = vi.spyOn(window, 'confirm')
    render(<SessionRow session={session()} info={{ allowBypass: true }} models={models} onChanged={onChanged} />)
    confirm.mockReturnValueOnce(false)
    fireEvent.click(screen.getByTestId('remote-session-delete'))
    expect(fetch).not.toHaveBeenCalled()
    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByTestId('remote-session-delete'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/rpc/agent_run_delete')
  })

  it('renames in place', async () => {
    const fetch = stubFetch()
    const onChanged = vi.fn()
    render(<SessionRow session={session()} info={{ allowBypass: true }} models={models} onChanged={onChanged} />)
    fireEvent.click(screen.getByTitle('Rename'))
    fireEvent.change(screen.getByLabelText('Session title'), { target: { value: 'Monthly' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(JSON.parse((fetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      id: 's1',
      title: 'Monthly',
    })
  })

  it('does not let a running session change model or access', () => {
    stubFetch()
    render(
      <SessionRow
        session={session({ status: 'running' })}
        info={{ allowBypass: true }}
        models={models}
        onChanged={vi.fn()}
      />
    )
    expect((screen.getByLabelText('Model') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Access') as HTMLSelectElement).disabled).toBe(true)
  })
})
