// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// On a page served by `flint serve` the Tauri bridge is the server transport
// (vite.config.ts aliases it when IS_WEB_APP is set); the same stand-in is
// used here so campaignApi is exercised the way the phone's WebView runs it.
vi.mock('@tauri-apps/api/core', async () => import('@/lib/tauriBridgeShim'))

import { campaignApi } from '@/lib/campaignApi'
import { parseRunnerInfo } from '@/lib/remoteRunner'
import { isServerDriven } from '@/lib/campaignModel'

afterEach(() => vi.unstubAllGlobals())

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  redirected: false,
  text: async () => JSON.stringify(body),
})

describe('campaigns over the server transport', () => {
  it('starts a campaign on the server with the goal, folder and options', async () => {
    const fetch = vi.fn().mockResolvedValue(okJson({ id: 'c-1', status: 'planned', driver: 'server' }))
    vi.stubGlobal('fetch', fetch)
    const made = await campaignApi.startServer('add search', '/srv/app', { maxParallel: 2 })
    expect(made.id).toBe('c-1')
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/rpc/agent_campaign_start_server')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      goal: 'add search',
      folder: '/srv/app',
      options: { maxParallel: 2 },
    })
  })

  it('approves with the access choice, and reads what waits on a person', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'c-1', status: 'running' }))
      .mockResolvedValueOnce(okJson({ approvals: [{ campaignId: 'c-1', kind: 'plan' }] }))
    vi.stubGlobal('fetch', fetch)
    await campaignApi.approve('c-1', 'ask')
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/rpc/agent_campaign_approve')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ id: 'c-1', access: 'ask' })
    const out = await campaignApi.approvals()
    expect(out.approvals[0]).toMatchObject({ kind: 'plan' })
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/rpc/agent_campaign_approvals')
  })

  it('reaches the review plane by the names the desktop uses', async () => {
    const fetch = vi.fn().mockResolvedValue(okJson([]))
    vi.stubGlobal('fetch', fetch)
    await campaignApi.list()
    await campaignApi.finalize('c-1')
    await campaignApi.gatePlan('c-1')
    const urls = fetch.mock.calls.map((c) => c[0])
    expect(urls).toEqual([
      '/api/v1/rpc/agent_campaign_list',
      '/api/v1/rpc/agent_campaign_finalize',
      '/api/v1/rpc/agent_campaign_gate_plan',
    ])
  })

  it('carries a refusal as an error the page can show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        redirected: false,
        text: async () => 'this server does not allow unattended access',
      })
    )
    await expect(campaignApi.approve('c-1', 'worktree')).rejects.toThrow(/unattended/)
  })

  it('asks the server driver for task moves by the names it lists', async () => {
    const fetch = vi.fn().mockResolvedValue(okJson({ campaign: {} }))
    vi.stubGlobal('fetch', fetch)
    const { setServerTransport } = await import('@/lib/serverTransportFlag')
    setServerTransport(true)
    try {
      await campaignApi.retryTask('c-1', 'a', 'use the other API')
      await campaignApi.acceptAnyway('c-1', 'a', 'me', 'read the diff')
      await campaignApi.verifyAgain('c-1', 'a')
      await campaignApi.resolveTask('c-1', 'a')
      await campaignApi.skipTask('c-1', 'a', 'cascade')
      await campaignApi.repairGate('c-1')
      await campaignApi.retryGate('c-1')
    } finally {
      setServerTransport(false)
    }
    const calls = fetch.mock.calls.map((c) => [c[0], JSON.parse(c[1].body)])
    expect(calls).toEqual([
      ['/api/v1/rpc/agent_campaign_retry_task', { id: 'c-1', taskId: 'a', hint: 'use the other API' }],
      // The server names the client itself: `by` is never sent.
      ['/api/v1/rpc/agent_campaign_accept_task', { id: 'c-1', taskId: 'a', reason: 'read the diff' }],
      ['/api/v1/rpc/agent_campaign_verify_again', { id: 'c-1', taskId: 'a' }],
      ['/api/v1/rpc/agent_campaign_resolve', { id: 'c-1', taskId: 'a' }],
      ['/api/v1/rpc/agent_campaign_skip_task', { id: 'c-1', taskId: 'a', dependants: 'cascade' }],
      ['/api/v1/rpc/agent_campaign_gate_repair', { id: 'c-1' }],
      ['/api/v1/rpc/agent_campaign_retry_gate', { id: 'c-1', seconds: null }],
    ])
  })

  it('starts a coordinator conversation with the flag, and reads the commands list', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(okJson({ coordinator: { id: 's-1', folder: '/srv/app', model: 'm' }, campaign: null }))
    vi.stubGlobal('fetch', fetch)
    const out = await campaignApi.startServerCoordinator('add search', '/srv/app')
    expect('coordinator' in out && out.coordinator.id).toBe('s-1')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      goal: 'add search',
      folder: '/srv/app',
      options: {},
      coordinator: true,
    })
    expect(
      parseRunnerInfo({ agent: true, campaignCommands: ['agent_campaign_skip_task', 7] }).campaignCommands
    ).toEqual(['agent_campaign_skip_task'])
    expect(parseRunnerInfo({ agent: true }).campaignCommands).toEqual([])
  })

  it('reads the capability and the driver field, tolerating an older server', () => {
    expect(parseRunnerInfo({ agent: true, runsCampaigns: true }).runsCampaigns).toBe(true)
    expect(parseRunnerInfo({ agent: true }).runsCampaigns).toBe(false)
    expect(isServerDriven({ driver: 'server' })).toBe(true)
    expect(isServerDriven({ driver: 'renderer' })).toBe(false)
    expect(isServerDriven({})).toBe(false)
  })
})
