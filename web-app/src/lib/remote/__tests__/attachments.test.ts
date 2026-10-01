import { describe, it, expect, vi } from 'vitest'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createActionHandlers, type RemoteActions } from '../actions'
import { createIdempotencyCache } from '../idempotency'
import { planAttachments } from '../attachments'
import type { RemoteUploadedFile } from '../api'

const up = (over: Partial<RemoteUploadedFile>): RemoteUploadedFile => ({
  id: 'a'.repeat(32), name: 'x.png', size: 10, mime: 'image/png', path: '/d/uploads/remote/x/x.png', dataUrl: 'data:image/png;base64,AA', ...over,
})
const t = (k: string) => k.split('.').pop()!

describe('planAttachments', () => {
  it('sends images to vision models and refuses them otherwise, with the composer reason', () => {
    const yes = planAttachments([up({})], { vision: true, audio: false, video: false }, t)
    expect(yes.files).toEqual([{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA' }])
    const no = planAttachments([up({})], { vision: false, audio: false, video: false }, t)
    expect(no.files).toEqual([])
    expect(no.rejected).toEqual([{ name: 'x.png', reason: 'needs-vision', message: 'needs-vision' }])
  })

  it('stages documents by path for the parse / RAG path', () => {
    const r = planAttachments([up({ name: 'spec.pdf', mime: 'application/pdf', dataUrl: null })], { vision: false, audio: false, video: false }, t)
    expect(r.docs[0]).toMatchObject({ type: 'document', name: 'spec.pdf', path: '/d/uploads/remote/x/x.png', fileType: 'pdf' })
  })

  it('applies the desktop size limit', () => {
    const r = planAttachments([up({ size: 21 * 1024 * 1024 })], { vision: true, audio: false, video: false }, t)
    expect(r.rejected[0].reason).toBe('too-large')
  })
})

describe('chat.send with attachments', () => {
  const ID = 'b'.repeat(32)
  function setup(over: Partial<RemoteActions>) {
    const a = {
      chatExists: () => true, chatBusy: () => false, open: vi.fn(), sendViaComposer: vi.fn(async () => true),
      stageDocs: vi.fn(), createChat: vi.fn(async () => 'c-new'), setWebSearch: vi.fn(), setChatReasoning: vi.fn(),
      ...over,
    } as unknown as RemoteActions
    const h = createActionHandlers(a, createIdempotencyCache()) as unknown as RemoteHandlers
    const call = (params: unknown) => dispatchRemoteRpc({ id: 'x', method: 'chat.send', params, device: { id: 'd1', name: 'P' } }, h)
    return { a, call }
  }

  it('passes media to the composer, stages documents and reports refusals', async () => {
    const prepareAttachments = vi.fn(async () => ({
      files: [{ type: 'file', mediaType: 'image/png', url: 'data:' }],
      docs: [{ type: 'document' as const, name: 'a.pdf', path: '/p/a.pdf' }],
      rejected: [{ name: 'b.mp3', reason: 'needs-audio', message: 'No audio' }],
    }))
    const { a, call } = setup({ prepareAttachments })
    const r = await call({ clientId: 'client-1', id: 'c1', text: '', attachments: [ID] })
    expect(prepareAttachments).toHaveBeenCalledWith('d1', { kind: 'chat', id: 'c1', model: undefined }, [ID])
    expect(a.stageDocs).toHaveBeenCalledWith('c1', [expect.objectContaining({ path: '/p/a.pdf' })])
    expect(a.sendViaComposer).toHaveBeenCalledWith('chat', 'c1', 'Please look at the attached file(s).', [expect.objectContaining({ mediaType: 'image/png' })])
    expect(r).toMatchObject({ result: { delivery: 'sent', rejected: [{ name: 'b.mp3', message: 'No audio' }] } })
  })

  it('fails with the reasons when every file is refused and there is no text', async () => {
    const { call } = setup({ prepareAttachments: async () => ({ files: [], docs: [], rejected: [{ name: 'x.png', reason: 'needs-vision', message: 'Cannot read images' }] }) })
    const r = await call({ clientId: 'client-2', id: 'c1', text: '', attachments: [ID] })
    expect(r).toMatchObject({ error: { code: 'rejected', message: 'x.png: Cannot read images' } })
  })

  it('refuses bad upload ids and files while a run is going', async () => {
    const { call } = setup({ prepareAttachments: async () => ({ files: [{ type: 'file', mediaType: 'image/png', url: 'd' }], docs: [], rejected: [] }), chatBusy: () => true })
    expect(await call({ clientId: 'client-3', id: 'c1', text: 'x', attachments: ['../etc'] })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call({ clientId: 'client-4', id: 'c1', text: 'x', attachments: [ID] })).toMatchObject({ error: { code: 'busy' } })
  })

  it('a new chat gets its files with the first message', async () => {
    const createChat = vi.fn(async () => 'c-new')
    const { call } = setup({ createChat, prepareAttachments: async () => ({ files: [{ type: 'file', mediaType: 'image/png', url: 'd' }], docs: [], rejected: [] }) })
    await call({ clientId: 'client-5', text: 'look', attachments: [ID] })
    expect(createChat).toHaveBeenCalledWith(expect.objectContaining({ text: 'look', files: [expect.objectContaining({ url: 'd' })] }))
  })
})
