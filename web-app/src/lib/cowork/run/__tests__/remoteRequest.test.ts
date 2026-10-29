import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  toastError: vi.fn(),
  sendRemoteTurn: vi.fn(),
  prepare: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: { error: m.toastError, info: vi.fn() } }))
vi.mock('@/lib/remoteCowork', () => ({ sendRemoteTurn: m.sendRemoteTurn }))
vi.mock('@/lib/coworkAttachments', async (orig) => ({
  ...(await orig<typeof import('@/lib/coworkAttachments')>()),
  prepareCoworkAttachments: m.prepare,
}))

import { sendRemoteRequest } from '../remoteRequest'

const base = {
  sid: 's1',
  t: (key: string) => key,
  serviceHub: {} as never,
}

describe('sendRemoteRequest, characterized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.sendRemoteTurn.mockResolvedValue(undefined)
  })

  it('refuses a resume (no text) without sending', async () => {
    const onRefused = vi.fn()
    await sendRemoteRequest({ ...base, text: null, onRefused })
    expect(m.toastError).toHaveBeenCalledWith(
      'A server session cannot resume from here. Send a message instead.'
    )
    expect(onRefused).toHaveBeenCalledOnce()
    expect(m.sendRemoteTurn).not.toHaveBeenCalled()
  })

  it('sends plain text as the turn, with no files', async () => {
    await sendRemoteRequest({ ...base, text: 'hi' })
    expect(m.sendRemoteTurn).toHaveBeenCalledWith('s1', 'hi', {}, undefined)
    expect(m.prepare).not.toHaveBeenCalled()
  })

  it('gives the draft back when the send fails', async () => {
    m.sendRemoteTurn.mockRejectedValue(new Error('offline'))
    const onRefused = vi.fn()
    await sendRemoteRequest({ ...base, text: 'hi', onRefused })
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledOnce())
    expect(m.toastError).toHaveBeenCalledWith('offline')
  })

  it('refuses when reading the attachments throws', async () => {
    m.prepare.mockRejectedValue(new Error('bad file'))
    const onRefused = vi.fn()
    await sendRemoteRequest({
      ...base,
      text: 'hi',
      onRefused,
      attachmentInput: { docs: [{ name: 'a.txt' }] } as never,
    })
    expect(m.toastError).toHaveBeenCalledWith('bad file')
    expect(onRefused).toHaveBeenCalledOnce()
    expect(m.sendRemoteTurn).not.toHaveBeenCalled()
  })

  it('appends document text to the message and reports unreadable files', async () => {
    m.prepare.mockResolvedValue({
      failed: [{ name: 'x.pdf', error: 'nope' }],
      modelSuffix: '\n\n[doc]',
      parts: [],
    })
    await sendRemoteRequest({
      ...base,
      text: 'hi',
      attachmentInput: { docs: [{ name: 'a.txt' }] } as never,
    })
    expect(m.toastError).toHaveBeenCalledWith('common:coworkRun.readFailed')
    expect(m.sendRemoteTurn).toHaveBeenCalledWith('s1', 'hi\n\n[doc]', {}, [])
  })
})
