import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { notificationFor, openApp, planClick, respondFromNotification, safeUrl } from '../sw/logic'
import { b64urlToBytes, minToTime, pushSupport, timeToMin } from '../state/push'
import { mirrorToken, memoryPairingStore } from '../api/storage'
import PushSettings from '../screens/PushSettings'
import { supportText } from '../state/push'
import { resetApp, useFixtures } from './helpers'
import { DEFAULT_PUSH } from '../state/push'

describe('service worker logic', () => {
  it('shows approval buttons only for approvals with a request id', () => {
    const a = notificationFor({ title: 'Approval waiting', body: 'x', url: '/m/#/chat/1', tag: 'approval-r1', category: 'approval', requestId: 'r1' })
    expect(a.options.actions?.map((x) => x.title)).toEqual(['Allow once', 'Deny'])
    expect(a.options.tag).toBe('approval-r1')
    const r = notificationFor({ title: 'Run finished', category: 'runFinished', url: '/m/' })
    expect(r.options.actions).toBeUndefined()
  })

  it('never opens a foreign url and shows something for junk', () => {
    expect(safeUrl('https://evil.example/m/')).toBe('/m/')
    expect(safeUrl('/m//evil.example')).toBe('/m/')
    expect(notificationFor('junk').title).toBe('Flint needs you')
  })

  it('plans clicks', () => {
    const data = { category: 'approval', requestId: 'r1', url: '/m/#/cowork/s' }
    expect(planClick('allow', data)).toEqual({ kind: 'respond', requestId: 'r1', decision: 'allow', url: '/m/#/cowork/s' })
    expect(planClick('', data)).toEqual({ kind: 'open', url: '/m/#/cowork/s' })
    expect(planClick('allow', { category: 'runFinished', url: '/m/' }).kind).toBe('open')
  })

  it('answers approvals with the stored token, allow once only', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: { status: 'answered' } }), { status: 200 }))
    const r = await respondFromNotification('r1', 'allow', { token: async () => 'tok', fetch, origin: 'https://pc.ts.net:1340' })
    expect(r).toBe('answered')
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://pc.ts.net:1340/remote/v1/rpc')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body)).params).toEqual({ requestId: 'r1', decision: 'allow', scope: 'once' })
    expect(await respondFromNotification('r1', 'deny', { token: async () => null, fetch, origin: '' })).toBe('unpaired')
    const f401 = vi.fn(async () => new Response('', { status: 401 }))
    expect(await respondFromNotification('r1', 'deny', { token: async () => 't', fetch: f401, origin: '' })).toBe('unpaired')
  })

  it('focuses an open app window or opens one', async () => {
    const focus = vi.fn(async () => undefined)
    const navigate = vi.fn(async () => undefined)
    const openWindow = vi.fn(async () => undefined)
    await openApp('/m/#/chat/1', { matchAll: async () => [{ url: 'https://h/m/#/', focus, navigate }], openWindow }, 'https://h')
    expect(navigate).toHaveBeenCalledWith('https://h/m/#/chat/1')
    expect(focus).toHaveBeenCalled()
    await openApp('/m/', { matchAll: async () => [], openWindow }, 'https://h')
    expect(openWindow).toHaveBeenCalledWith('https://h/m/')
  })
})

describe('push helpers', () => {
  it('detects support, iOS home screen and insecure origins', () => {
    const base = { isSecureContext: true, hasSw: true, hasPush: true, ios: false, standalone: false }
    expect(pushSupport(base)).toEqual({ ok: true })
    expect(pushSupport({ ...base, isSecureContext: false })).toEqual({ ok: false, why: 'insecure' })
    expect(pushSupport({ ...base, ios: true })).toEqual({ ok: false, why: 'ios-home-screen' })
    expect(pushSupport({ ...base, ios: true, standalone: true })).toEqual({ ok: true })
    expect(supportText({ ok: false, why: 'ios-home-screen' })).toMatch(/16\.4/)
    expect(supportText({ ok: false, why: 'insecure' })).toMatch(/self-signed/)
  })

  it('converts keys and times', () => {
    expect([...b64urlToBytes('AQID_w')]).toEqual([1, 2, 3, 255])
    expect(minToTime(22 * 60 + 5)).toBe('22:05')
    expect(timeToMin('07:30')).toBe(450)
    expect(timeToMin('25:00')).toBeNull()
  })

  it('mirrors the token for the service worker', () => {
    const write = vi.fn()
    const s = mirrorToken(memoryPairingStore(), write)
    s.set({ token: 't1', deviceId: 'd', deviceName: 'P', pairedAt: 1 })
    s.clear()
    expect(write.mock.calls.map((c) => c[0])).toEqual([null, 't1', null])
  })
})

describe('Settings > Notifications', () => {
  beforeEach(() => resetApp({ name: 'settings-sub', sub: 'notifs' }))

  it('explains what is needed when push is unavailable', () => {
    useFixtures()
    render(<PushSettings support={{ ok: false, why: 'ios-home-screen' }} />)
    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy()
    expect(screen.queryByTestId('push-test')).toBeNull()
  })

  it('shows the switches and saves them on the computer', async () => {
    const client = useFixtures({
      'push.get': { subscribed: true, available: true, prefs: DEFAULT_PUSH },
      'push.prefs': { prefs: DEFAULT_PUSH },
      'push.test': { sent: 1 },
    })
    render(<PushSettings support={{ ok: true }} />)
    await screen.findByTestId('push-test')
    expect(screen.getByText('A Room synthesis is ready')).toBeTruthy()
    fireEvent.click(screen.getByTestId('push-chatReply'))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('push.prefs', expect.objectContaining({ prefs: expect.objectContaining({ chatReply: true }) })))
    fireEvent.click(screen.getByTestId('push-quiet'))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('push.prefs', expect.objectContaining({ prefs: expect.objectContaining({ quietHours: expect.objectContaining({ enabled: true }) }) })))
    fireEvent.click(screen.getByTestId('push-test'))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('push.test', {}))
  })
})
