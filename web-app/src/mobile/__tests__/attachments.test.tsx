import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { fitWithin, downscaleImage } from '../ui/downscale'
import { attachments, addDeskFile, addFiles, outgoing, insertIntoComposer } from '../state/attachments'
import { Composer } from '../shell/Composer'
import { resetApp, useFixtures } from './helpers'
import { sendMessage } from '../state/app'
import { RemoteClient } from '../api/client'
import { memoryPairingStore } from '../api/storage'

beforeEach(() => {
  resetApp()
  attachments.reset()
})

describe('downscaling', () => {
  it('fits the long edge to 2048', () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: 2048, h: 1536 })
    expect(fitWithin(800, 600)).toBeNull()
  })
  it('re-encodes big photos and leaves small ones', async () => {
    const big = new File([new Uint8Array(3_000_000)], 'IMG_1.HEIC.jpeg', { type: 'image/jpeg' })
    const encode = vi.fn(async () => new Blob([new Uint8Array(500_000)], { type: 'image/jpeg' }))
    const out = await downscaleImage(big, { decode: async () => ({ width: 4032, height: 3024 }) as never, encode })
    expect(encode).toHaveBeenCalledWith(expect.anything(), 2048, 1536)
    expect(out.size).toBe(500_000)
    expect(out.name).toBe('IMG_1.HEIC.jpg')
    const small = new File([new Uint8Array(1000)], 's.png', { type: 'image/png' })
    expect(await downscaleImage(small, { decode: async () => ({ width: 100, height: 100 }) as never, encode })).toBe(small)
  })
})

describe('uploads', () => {
  it('uploads in chunks and resumes from where the computer is', async () => {
    const calls: string[] = []
    let putN = 0
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`)
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (url.endsWith('/upload')) return json({ uploadId: 'u1', chunkSize: 65536 })
      if (url.includes('/finish')) return json({ uploadId: 'u1', name: 'f.txt', size: 100000, mime: 'text/plain' })
      putN++
      if (putN === 2) return json({ error: { code: 'bad_offset', message: 'Resume from byte 65536' } }, 409)
      const off = Number(/offset=(\d+)/.exec(url)![1])
      return json({ received: Math.min(100000, off + 65536) })
    })
    const c = new RemoteClient({ store: memoryPairingStore({ token: 't', deviceId: 'd', deviceName: 'P', pairedAt: 1 }), fetchImpl: fetchImpl as never })
    const progress: number[] = []
    const info = await c.upload(new File([new Uint8Array(100000)], 'f.txt', { type: 'text/plain' }), (f) => progress.push(f))
    expect(info.mime).toBe('text/plain')
    expect(calls.filter((x) => x.startsWith('PUT')).map((x) => x.split('?')[1])).toEqual(['offset=0', 'offset=65536', 'offset=65536'])
    expect(progress.at(-1)).toBe(1)
  })

  it('sends ready uploads with the message and clears the chips', async () => {
    const client = useFixtures({ 'chat.send': { kind: 'chat', id: 'c1', delivery: 'sent', rejected: [{ name: 'a.png', reason: 'needs-vision', message: 'The selected model cannot read images' }] } })
    ;(client as unknown as { upload: unknown }).upload = vi.fn(async (f: File) => ({ uploadId: 'f'.repeat(32), name: f.name, size: f.size, mime: f.type }))
    await addFiles('chat:c1', [new File(['hi'], 'a.txt', { type: 'text/plain' })])
    expect(outgoing('chat:c1')).toMatchObject({ ok: true, uploadIds: ['f'.repeat(32)] })
    await sendMessage('chat.send', { id: 'c1', text: 'see' })
    expect(client.rpc).toHaveBeenCalledWith('chat.send', expect.objectContaining({ attachments: ['f'.repeat(32)], text: 'see' }))
    expect(attachments.get().by['chat:c1']).toBeUndefined()
  })

  it('files on the computer go as @ references', () => {
    addDeskFile('cowork:w1', 'src/app.ts')
    expect(outgoing('cowork:w1')).toMatchObject({ ok: true, uploadIds: [], refs: ['@src/app.ts'] })
  })
})

describe('composer chips and inserts', () => {
  it('shows chips with remove, and inserts @ references at the cursor', async () => {
    useFixtures()
    addDeskFile('cowork:w1', 'README.md')
    render(<Composer placeholder="Ask" onSend={() => true} plus={{ for: 'cowork', id: 'w1' }} />)
    expect(screen.getByTestId('attach-chips').textContent).toContain('README.md')
    insertIntoComposer('cowork:w1', '@src/a.ts#L3-L9')
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('@src/a.ts#L3-L9 '))
    fireEvent.click(screen.getByLabelText('Remove README.md'))
    expect(screen.queryByTestId('attach-chips')).toBeNull()
  })
})
