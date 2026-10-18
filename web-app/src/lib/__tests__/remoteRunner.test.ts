import { describe, it, expect } from 'vitest'
import {
  parseRunnerInfo,
  parseSse,
  replaySession,
  probeRunner,
  runnerBanner,
  listRemoteSessions,
  listRunModels,
  renameRun,
  setRunAccess,
  setRunModel,
  startRun,
  allowedAccess,
  approveRun,
} from '../remoteRunner'

const ok = (body: string) => new Response(body, { status: 200 })

describe('remoteRunner', () => {
  it('reads an old server answer as not running', () => {
    const info = parseRunnerInfo({ agent: true, folders: ['/w'] })
    expect(info.runsSessions).toBe(false)
    expect(info.roots).toEqual(['/w'])
    expect(runnerBanner(info).ok).toBe(false)
    expect(runnerBanner(parseRunnerInfo({ agent: false })).text).toContain('--agent-run')
  })

  it('says connected only when the server reports it runs sessions', () => {
    const info = parseRunnerInfo({ agent: true, runsSessions: true, enforces: true })
    expect(runnerBanner(info)).toEqual({ ok: true, text: 'This server can run agents: connected.' })
  })

  it('probes and lists through the rpc endpoint', async () => {
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return ok(
        url.endsWith('agent_run_list') ? '{"sessions":[{"id":"a"}]}' : '{"agent":true,"missing":["x"]}'
      )
    }
    expect((await probeRunner(fetchImpl)).missing).toEqual(['x'])
    expect(await listRemoteSessions(fetchImpl)).toHaveLength(1)
    expect(seen[0]).toBe('/api/v1/rpc/agent_server_info')
  })

  it('parses events and the end marker, skipping comments and junk', () => {
    const body =
      ': replay\n\nid: 1\ndata: {"seq":1,"kind":"message"}\n\nid: 2\ndata: not json\n\n' +
      'event: end\ndata: {"last":1,"more":false}\n\n'
    const parsed = parseSse(body)
    expect(parsed.events.map((e) => e.seq)).toEqual([1])
    expect(parsed.end).toEqual({ last: 1, more: false })
  })

  it('follows pages with after= until the server says no more', async () => {
    const urls: string[] = []
    const fetchImpl = async (url: string) => {
      urls.push(url)
      return url.endsWith('after=0')
        ? ok('data: {"seq":1,"kind":"m"}\n\nevent: end\ndata: {"last":1,"more":true}\n\n')
        : ok('data: {"seq":2,"kind":"m"}\n\nevent: end\ndata: {"last":2,"more":false}\n\n')
    }
    const out = await replaySession('s1', { fetchImpl })
    expect(out.events.map((e) => e.seq)).toEqual([1, 2])
    expect(out.last).toBe(2)
    expect(urls[1]).toContain('after=1')
    const resumed = await replaySession('s1', { after: 1, fetchImpl })
    expect(resumed.events.map((e) => e.seq)).toEqual([2])
  })

  it('surfaces a refusal', async () => {
    const fetchImpl = async () => new Response('outside', { status: 403 })
    await expect(replaySession('s', { fetchImpl })).rejects.toThrow('outside')
  })

  it('lists the models the server can run, and tolerates an odd answer', async () => {
    const body = JSON.stringify({
      models: [{ id: 'm', provider: 'p', label: 'p / m', contextWindow: 128000, supportsTools: null }],
      default: 'm',
    })
    expect(await listRunModels(async () => ok(body))).toEqual({
      models: [{ id: 'm', provider: 'p', label: 'p / m', contextWindow: 128000, supportsTools: null }],
      default: 'm',
    })
    expect(await listRunModels(async () => ok('{}'))).toEqual({ models: [], default: null })
  })

  it('changes a session by id with the commands the server answers', async () => {
    const seen: Array<[string, unknown]> = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push([url, JSON.parse(String(init?.body))])
      return ok('{}')
    }
    await setRunModel('s1', 'm', fetchImpl)
    await setRunAccess('s1', 'read', fetchImpl)
    await renameRun('s1', 'Report', fetchImpl)
    expect(seen).toEqual([
      ['/api/v1/rpc/agent_run_set_model', { id: 's1', model: 'm' }],
      ['/api/v1/rpc/agent_run_set_mode', { id: 's1', access: 'read' }],
      ['/api/v1/rpc/agent_run_rename', { id: 's1', title: 'Report' }],
    ])
  })

  it('offers unattended access only when the server allows it', () => {
    expect(allowedAccess({ allowBypass: false })).toEqual(['read', 'ask'])
    expect(allowedAccess({ allowBypass: true })).toEqual(['read', 'ask', 'auto'])
  })

  it('sends attachments with the message only when there are some', async () => {
    const bodies: unknown[] = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok('{"turnId":"t","after":0}')
    }
    await startRun('s1', 'hello', fetchImpl)
    await startRun('s1', 'look', fetchImpl, [{ name: 'a.png', mime: 'image/png', data: 'QUJD' }])
    expect(bodies[0]).toEqual({ id: 's1', input: 'hello' })
    expect(bodies[1]).toEqual({
      id: 's1',
      input: 'look',
      attachments: [{ name: 'a.png', mime: 'image/png', data: 'QUJD' }],
    })
  })

  it('answers an approval with its scope, or later, only when asked to', async () => {
    const bodies: unknown[] = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return ok('{}')
    }
    await approveRun('s1', 'perm-1', 'allow_once', fetchImpl)
    await approveRun('s1', 'perm-2', 'allow_always', fetchImpl, { type: 'folder', dir: 'C:/p/src' })
    await approveRun('s1', 'perm-3', 'defer', fetchImpl)
    expect(bodies).toEqual([
      { id: 's1', requestId: 'perm-1', decision: 'allow_once' },
      { id: 's1', requestId: 'perm-2', decision: 'allow_always', scope: { type: 'folder', dir: 'C:/p/src' } },
      { id: 's1', requestId: 'perm-3', decision: 'defer' },
    ])
  })
})
