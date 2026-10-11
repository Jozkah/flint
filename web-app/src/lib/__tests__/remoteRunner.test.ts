import { describe, it, expect } from 'vitest'
import {
  parseRunnerInfo,
  parseSse,
  replaySession,
  probeRunner,
  runnerBanner,
  listRemoteSessions,
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
})
