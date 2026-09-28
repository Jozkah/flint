import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act as rtlAct, render, screen, fireEvent, within } from '@testing-library/react'
import type { RemoteEvent } from '@/lib/remote/protocol'
import { Shell } from '../shell/Shell'
import { RemoteCallError } from '../api/client'
import { app, handleEvent, respondApproval, sendMessage } from '../state/app'
import { applyStreamEvent, live, pendingFor, spliceAt, type LiveStream } from '../state/live'
import { primeRpc } from '../state/rpc'
import { resetApp, useFixtures } from './helpers'

const T = { timeout: 3000 }

const delta = (offset: number, text: string, over: Partial<Extract<RemoteEvent, { type: 'stream.delta' }>> = {}): RemoteEvent => ({
  type: 'stream.delta',
  kind: 'chat',
  id: 'c1',
  messageId: 'a9',
  offset,
  text,
  ...over,
})

function resetLive() {
  live.set({ streams: {}, pending: [], resolved: {} })
}

describe('stream reducer', () => {
  it('spliceAt appends, rewrites from an earlier offset, and reports gaps', () => {
    expect(spliceAt('Hel', 3, 'lo')).toBe('Hello')
    expect(spliceAt('Hello', 0, 'Bye')).toBe('Bye')
    expect(spliceAt('Hel', 5, 'x')).toBeNull()
  })

  it('builds a reply from deltas and tool steps, then marks it done', () => {
    let s: Record<string, LiveStream> = {}
    s = applyStreamEvent(s, delta(0, 'The cache ')).streams
    s = applyStreamEvent(s, delta(10, 'key', { reasoningOffset: 0, reasoning: 'hmm' })).streams
    s = applyStreamEvent(s, {
      type: 'stream.tool',
      kind: 'chat',
      id: 'c1',
      messageId: 'a9',
      step: { id: 't1', name: 'read', kind: 'read', status: 'running' },
    }).streams
    s = applyStreamEvent(s, {
      type: 'stream.tool',
      kind: 'chat',
      id: 'c1',
      messageId: 'a9',
      step: { id: 't1', name: 'read', kind: 'read', status: 'done' },
    }).streams
    expect(s.c1).toMatchObject({ text: 'The cache key', reasoning: 'hmm', done: false })
    expect(s.c1.tools).toEqual([{ id: 't1', name: 'read', kind: 'read', status: 'done' }])
    const out = applyStreamEvent(s, { type: 'stream.done', kind: 'chat', id: 'c1', messageId: 'a9' })
    expect(out.streams.c1.done).toBe(true)
    expect(out.finished).toEqual({ kind: 'chat', id: 'c1' })
  })

  it('asks for a snapshot after a gap, keeping what is shown', () => {
    const s = applyStreamEvent({}, delta(0, 'abc')).streams
    const out = applyStreamEvent(s, delta(10, 'xyz'))
    expect(out.gap).toEqual({ kind: 'chat', id: 'c1' })
    expect(out.streams.c1.text).toBe('abc')
    // A delta for a message it never saw the start of is a gap too.
    expect(applyStreamEvent({}, delta(5, 'x', { messageId: 'other' })).gap).toBeTruthy()
  })

  it('a replayed delta after a reconnect does not duplicate text', () => {
    let s = applyStreamEvent({}, delta(0, 'Hello')).streams
    s = applyStreamEvent(s, delta(0, 'Hello')).streams
    s = applyStreamEvent(s, delta(3, 'lo wor')).streams
    expect(s.c1.text).toBe('Hello wor')
  })

  it('pending sends show until the stored messages hold them', () => {
    const p = [{ clientId: 'x', kind: 'chat' as const, id: 'c1', text: 'Hi', status: 'sent' as const, at: 1000 }]
    expect(pendingFor(p, 'c1', [])).toHaveLength(1)
    expect(pendingFor(p, 'c1', [{ id: 'u', role: 'user', text: 'Hi', createdAt: 2000 }])).toHaveLength(0)
    expect(pendingFor(p, 'c2', [])).toHaveLength(0)
  })
})

describe('sending from the phone', () => {
  beforeEach(() => {
    resetApp({ name: 'chat', id: 'c1' })
    resetLive()
  })

  it('retries a send that lost its connection under the same clientId', async () => {
    const client = useFixtures()
    let calls = 0
    client.rpc.mockImplementation(async (method: string) => {
      if (method !== 'chat.send') return {}
      calls++
      if (calls === 1) throw new RemoteCallError('network', "Can't reach your computer")
      return { kind: 'chat', id: 'c1', delivery: 'sent' }
    })
    const r = await sendMessage('chat.send', { id: 'c1', text: 'Hi' }, { retryDelayMs: 1 })
    expect(r).toEqual({ kind: 'chat', id: 'c1', delivery: 'sent' })
    const ids = client.rpc.mock.calls.filter((c) => c[0] === 'chat.send').map((c) => (c[1] as { clientId: string }).clientId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(live.get().pending[0]).toMatchObject({ status: 'sent', text: 'Hi' })
  })

  it('a refusal is not retried and leaves the message marked not sent', async () => {
    const client = useFixtures()
    client.rpc.mockImplementation(async () => {
      throw new RemoteCallError('desktop_only', 'That is done on the computer')
    })
    expect(await sendMessage('cowork.send', { id: 'w1', text: 'x' })).toBeUndefined()
    expect(client.rpc).toHaveBeenCalledTimes(1)
    expect(live.get().pending[0].status).toBe('failed')
    expect(app.get().toast?.text).toBe('That is done on the computer.')
  })

  it('a timeout surfaces as a toast', async () => {
    const client = useFixtures()
    client.rpc.mockImplementation(async () => {
      throw new RemoteCallError('timeout', 'slow')
    })
    await sendMessage('chat.send', { id: 'c1', text: 'x' }, { retryDelayMs: 1 })
    expect(client.rpc).toHaveBeenCalledTimes(3)
    expect(app.get().toast?.text).toBe("Your computer didn't answer in time")
  })

  it('says when an approval was already answered on the computer', async () => {
    const client = useFixtures()
    client.rpc.mockImplementation(async (m: string) => (m === 'approvals.respond' ? { status: 'gone' } : {}))
    await respondApproval({ requestId: 'ap1', threadId: 'w1' }, 'allow')
    expect(live.get().resolved.ap1).toMatchObject({ by: 'computer', label: 'Answered from the computer' })
  })
})

describe('live screens', () => {
  beforeEach(() => resetLive())

  it('Chat streams a reply with the caret, then shows the stored message', async () => {
    const client = useFixtures()
    resetApp({ name: 'chat', id: 'c1' })
    render(<Shell />)
    expect(await screen.findByText(/The cache key is built from the region only/, {}, T)).toBeInTheDocument()
    rtlAct(() => {
      handleEvent(delta(0, 'Streaming the '))
      handleEvent(delta(14, 'answer'))
    })
    const msg = await screen.findByTestId('streaming-message')
    expect(within(msg).getByText('Streaming the answer')).toBeInTheDocument()
    expect(within(msg).getByTestId('caret')).toBeInTheDocument()
    rtlAct(() => handleEvent({ type: 'stream.done', kind: 'chat', id: 'c1', messageId: 'a9' }))
    await vi.waitFor(() => expect(screen.queryByTestId('streaming-message')).toBeNull(), T)
    expect(client.rpc).toHaveBeenCalledWith('stream.get', { kind: 'chat', id: 'c1' })
  })

  it('Cowork shows a tool step arriving live, and the change bars', async () => {
    useFixtures()
    resetApp({ name: 'cowork', id: 'w1' })
    render(<Shell />)
    expect(await screen.findByText('Used read', {}, T)).toBeInTheDocument()
    rtlAct(() =>
      handleEvent({
        type: 'stream.tool',
        kind: 'cowork',
        id: 'w1',
        messageId: 'run1',
        step: { id: 'z1', name: 'bash', kind: 'bash', status: 'running', arg: 'go test ./...', origin: 'Workspace' },
      })
    )
    const msg = await screen.findByTestId('streaming-message')
    expect(within(msg).getByText('go test ./...')).toBeInTheDocument()
    const bars = await screen.findByTestId('change-bars', {}, T)
    expect(within(bars).getByText('2 files ready for review')).toBeInTheDocument()
    expect(within(bars).getByText('flint/radar-retry')).toBeInTheDocument()
  })

  it('an approval answered on the computer turns into one line', async () => {
    useFixtures()
    resetApp({ name: 'cowork', id: 'w1' })
    render(<Shell />)
    const card = await screen.findByTestId('approval-card', {}, T)
    // Always allow is not offered while the computer does not permit it.
    fireEvent.click(within(card).getByText('Permission details'))
    expect(screen.queryByText(/Always allow/)).toBeNull()
    rtlAct(() => handleEvent({ type: 'approval.resolved', requestId: 'ap1' }))
    expect(await screen.findByText('Answered from the computer', {}, T)).toBeInTheDocument()
  })

  it('Room sends to a participant with a clientId', async () => {
    const client = useFixtures({ 'room.send': { kind: 'room', id: 'r1', delivery: 'sent' } })
    primeRpc('status', {}, { modelsLoaded: 1, runs: [], approvalsWaiting: 0 })
    resetApp({ name: 'room', id: 'r1' })
    render(<Shell />)
    const box = await screen.findByLabelText('Message to the room', {}, T)
    fireEvent.change(box, { target: { value: 'Keep it short' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Message' }))
    await vi.waitFor(() =>
      expect(client.rpc).toHaveBeenCalledWith(
        'room.send',
        expect.objectContaining({ id: 'r1', text: 'Keep it short', to: null, clientId: expect.stringMatching(/^m-/) })
      )
    )
  })
})
