import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dispatchRemoteRpc, type RemoteHandlers } from '../bridge'
import { createStudioHandlers, MAX_AUDIO_B64, type RemoteStudio, type RemoteVoice } from '../studio'

const device = { id: 'd1', name: 'Pixel' }
let handlers: RemoteHandlers
const call = (method: string, params: unknown) => dispatchRemoteRpc({ id: 'x', method, params, device }, handlers)

const wavB64 = () => {
  const b = new Uint8Array(44)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8)
  return btoa(String.fromCharCode(...b))
}

describe('studio and voice handlers', () => {
  let s: RemoteStudio
  let v: RemoteVoice
  beforeEach(() => {
    s = {
      status: vi.fn(async () => ({ supported: true }) as never),
      load: vi.fn(async () => {}),
      unload: vi.fn(async () => {}),
      download: vi.fn(async () => {}),
      generate: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      gallery: vi.fn(async () => []),
      media: vi.fn(async (_k, id: string) => (id === 'a1' ? 'data:image/png;base64,AA' : null)),
      remix: vi.fn(async (_k, id: string) => id === 'a1'),
      remove: vi.fn(async () => {}),
    }
    v = { ready: vi.fn(() => true), transcribe: vi.fn(async () => ' hello there ') }
    handlers = createStudioHandlers(s, v) as unknown as RemoteHandlers
  })

  it('validates and starts a generation', async () => {
    expect(await call('studio.generate', { kind: 'image', prompt: ' fox ', count: 4, seed: 7 })).toEqual({ result: { started: true } })
    expect(s.generate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', prompt: 'fox', count: 4, seed: 7, memoryAcknowledged: false }))
    expect(await call('studio.generate', { kind: 'audio', prompt: 'x' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('studio.generate', { kind: 'image', prompt: '' })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('studio.generate', { kind: 'image', prompt: 'x', count: 9 })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('studio.generate', { kind: 'image', prompt: 'x', seed: -1 })).toMatchObject({ error: { code: 'bad_params' } })
  })

  it('serves media by gallery id only, never by path', async () => {
    expect(await call('studio.media', { kind: 'image', id: 'a1' })).toEqual({ result: { dataUrl: 'data:image/png;base64,AA' } })
    expect(await call('studio.media', { kind: 'image', id: 'zz' })).toMatchObject({ error: { code: 'not_found' } })
    for (const id of ['../secret', '/etc/passwd', 'C:\\x', 'a/b']) {
      expect(await call('studio.media', { kind: 'image', id })).toMatchObject({ error: { code: 'bad_params' } })
    }
    expect(s.media).toHaveBeenCalledTimes(2)
  })

  it('remixes, deletes, loads and stops', async () => {
    expect(await call('studio.remix', { kind: 'video', id: 'a1' })).toEqual({ result: { started: true } })
    expect(await call('studio.remix', { kind: 'video', id: 'b2' })).toMatchObject({ error: { code: 'not_found' } })
    await call('studio.delete', { kind: 'image', id: 'a1' })
    expect(s.remove).toHaveBeenCalledWith('image', 'a1')
    await call('studio.load', { modelId: 'z-image-turbo' })
    expect(s.load).toHaveBeenCalledWith('z-image-turbo')
    expect(await call('studio.load', {})).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('studio.stop', {})).toEqual({ result: { ok: true } })
  })

  it('transcribes a WAV and refuses anything else', async () => {
    expect(await call('voice.status', {})).toEqual({ result: { ready: true } })
    expect(await call('voice.transcribe', { audio: wavB64() })).toEqual({ result: { text: 'hello there' } })
    expect(await call('voice.transcribe', { audio: btoa('not a wav at all, definitely not one here...') })).toMatchObject({ error: { code: 'bad_params' } })
    expect(await call('voice.transcribe', { audio: 'A'.repeat(MAX_AUDIO_B64 + 4) })).toMatchObject({ error: { code: 'too_large' } })
    vi.mocked(v.ready).mockReturnValue(false)
    expect(await call('voice.status', {})).toEqual({ result: { ready: false } })
    expect(await call('voice.transcribe', { audio: wavB64() })).toMatchObject({ error: { code: 'not_ready' } })
  })

  it('without the app side, says it is not available', async () => {
    handlers = createStudioHandlers() as unknown as RemoteHandlers
    expect(await call('studio.status', {})).toMatchObject({ error: { code: 'not_implemented' } })
    expect(await call('voice.status', {})).toEqual({ result: { ready: false } })
  })
})

describe('library.list with Studio', () => {
  it('merges Studio items newest first with a Studio source', async () => {
    const { mergeStudioLibrary } = await import('../studio')
    const cowork = [{ path: 'a.md', title: 'a', group: 'Document', label: 'MD', sessionId: 's1', sessionTitle: 'S', updatedAt: 10 }]
    const studio = [{ id: 'v1', kind: 'video' as const, recipe: { prompt: 'Waves', createdAtMs: 20 } as never }]
    const rows = mergeStudioLibrary(cowork, studio)
    expect(rows.map((r) => r.title)).toEqual(['Waves', 'a'])
    expect(rows[0]).toMatchObject({ group: 'Video', label: 'WEBM', sessionTitle: 'Studio', path: 'v1.webm', studio: { id: 'v1' } })
  })
})
