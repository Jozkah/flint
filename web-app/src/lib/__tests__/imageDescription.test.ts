import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const run = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }))
const toastFn = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/lib/utilityAgents', () => ({ runUtilityAgent: run }))
vi.mock('@/lib/model-factory', () => ({ ModelFactory: { createModel: create } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('sonner', () => ({ toast: toastFn }))

import {
  clearImageDescriptionCache,
  describeImagesInMessages,
  embedImageDescriptions,
  fingerprint,
  pickDescriber,
  visionModels,
} from '../imageDescription'
import { useImageDescription } from '@/hooks/useImageDescription'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { Attachment } from '@/types/attachment'

const providers = [
  { provider: 'llamacpp', active: true, models: [{ id: 'local-vl', capabilities: ['vision'] }, { id: 'text', capabilities: [] }] },
  { provider: 'openai', active: true, models: [{ id: 'gpt-vision', capabilities: ['vision', 'tools'] }, { id: 'emb', capabilities: ['vision'], embedding: true }] },
  { provider: 'off', active: false, models: [{ id: 'hidden', capabilities: ['vision'] }] },
]

const png = (n: number) => `data:image/png;base64,${'A'.repeat(20)}${n}`
const userMessage = (...urls: string[]): UIMessage =>
  ({
    id: 'u',
    role: 'user',
    parts: [{ type: 'text', text: 'what is this?' }, ...urls.map((url) => ({ type: 'file', mediaType: 'image/png', url }))],
  }) as unknown as UIMessage

const describer = { provider: 'openai', modelId: 'gpt-vision' }

beforeEach(() => {
  run.mockReset()
  create.mockReset().mockResolvedValue({})
  tauri.invoke.mockReset().mockResolvedValue(undefined)
  toastFn.error.mockReset()
  clearImageDescriptionCache()
  useImageDescription.setState({ enabled: true, model: null, embed: false })
  useModelProvider.setState({
    providers: providers as never,
    getProviderByName: (name: string) => providers.find((p) => p.provider === name) as never,
  } as never)
})

describe('visionModels and pickDescriber', () => {
  it('lists models that can see, from providers that are on, without embedding models', () => {
    expect(visionModels(providers).map((m) => m.modelId)).toEqual(['local-vl', 'gpt-vision'])
  })

  it('picks the first remote model that can see, never a local one on its own', () => {
    expect(pickDescriber(providers, { enabled: true, model: null })).toEqual(describer)
    const onlyLocal = [providers[0]]
    expect(pickDescriber(onlyLocal, { enabled: true, model: null })).toBeNull()
  })

  it('uses the user\'s choice when it still exists, a local model included', () => {
    expect(
      pickDescriber(providers, { enabled: true, model: { provider: 'llamacpp', id: 'local-vl' } })
    ).toEqual({ provider: 'llamacpp', modelId: 'local-vl' })
    expect(
      pickDescriber(providers, { enabled: true, model: { provider: 'llamacpp', id: 'gone' } })
    ).toEqual(describer)
  })

  it('picks nothing when the feature is off', () => {
    expect(pickDescriber(providers, { enabled: false, model: null })).toBeNull()
  })
})

describe('describeImagesInMessages', () => {
  it('puts a description where each image was, and leaves the text alone', async () => {
    run.mockResolvedValue('A red bicycle against a wall. Text: "PARK HERE"')
    const out = await describeImagesInMessages([userMessage(png(1))], describer, { session: 's' })
    const parts = out[0].parts as { type: string; text?: string }[]
    expect(parts[0]).toMatchObject({ type: 'text', text: 'what is this?' })
    expect(parts[1].type).toBe('text')
    expect(parts[1].text).toContain('described because this model cannot see images')
    expect(parts[1].text).toContain('A red bicycle')
    expect(parts.some((p) => p.type === 'file')).toBe(false)
  })

  it('asks the describer with the image and a request to transcribe text', async () => {
    run.mockResolvedValue('desc')
    await describeImagesInMessages([userMessage(png(1))], describer, { session: 's1' })
    const req = run.mock.calls[0][0]
    expect(req.kind).toBe('describe')
    expect(req.session).toBe('s1')
    expect(req.modelId).toBe('gpt-vision')
    const content = req.messages[0].content
    expect(content[0].text).toMatch(/transcribe any visible text/)
    expect(content[1]).toEqual({ type: 'image', image: png(1) })
  })

  it('describes an image once however often it is sent', async () => {
    run.mockResolvedValue('desc')
    const messages = [userMessage(png(1)), userMessage(png(1))]
    await describeImagesInMessages(messages, describer, { session: 's' })
    await describeImagesInMessages(messages, describer, { session: 's' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('numbers several images in a message', async () => {
    run.mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    const out = await describeImagesInMessages([userMessage(png(1), png(2))], describer, { session: 's' })
    const texts = (out[0].parts as { text?: string }[]).map((p) => p.text ?? '')
    expect(texts.join('\n')).toContain('Attached image 1')
    expect(texts.join('\n')).toContain('Attached image 2')
  })

  it('leaves an image it could not describe in place, and says so once', async () => {
    run.mockRejectedValue(new Error('provider down'))
    const out = await describeImagesInMessages([userMessage(png(1), png(2))], describer, { session: 's' })
    expect((out[0].parts as { type: string }[]).filter((p) => p.type === 'file')).toHaveLength(2)
    expect(toastFn.error).toHaveBeenCalledTimes(1)
    expect(toastFn.error.mock.calls[0][0]).toContain('provider down')
  })

  it('does nothing for messages without images, and never touches assistant messages', async () => {
    const plain = { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] } as unknown as UIMessage
    const withText = { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as unknown as UIMessage
    const messages = [withText, plain]
    expect(await describeImagesInMessages(messages, describer, { session: 's' })).toBe(messages)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('embedImageDescriptions', () => {
  const image = (n: number): Attachment => ({ name: `shot${n}.png`, type: 'image', dataUrl: png(n), mimeType: 'image/png' })
  const hub = () => {
    const ingest = vi.fn().mockResolvedValue({ id: 'doc-1', size: 40, chunkCount: 2 })
    const ingestProject = vi.fn().mockResolvedValue({ id: 'doc-p' })
    return {
      ingest,
      ingestProject,
      serviceHub: {
        app: () => ({ getJanDataFolder: async () => 'C:/data' }),
        uploads: () => ({ ingestFileAttachment: ingest, ingestFileAttachmentForProject: ingestProject }),
      } as never,
    }
  }

  it('does nothing unless the user turned it on', async () => {
    const { serviceHub, ingest } = hub()
    expect(await embedImageDescriptions({ images: [image(1)], threadId: 't', serviceHub })).toEqual([])
    expect(ingest).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('describes each image, writes it under the data folder and ingests it as a document', async () => {
    useImageDescription.setState({ embed: true })
    run.mockResolvedValue('A chart of monthly revenue.')
    const { serviceHub, ingest } = hub()
    const docs = await embedImageDescriptions({ images: [image(1)], threadId: 't', serviceHub })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      name: 'shot1.png (description)',
      type: 'document',
      id: 'doc-1',
      injectionMode: 'embeddings',
      processed: true,
    })
    const mkdirCall = tauri.invoke.mock.calls.find((c) => c[0] === 'mkdir')!
    expect(mkdirCall[1].args[0]).toBe('C:/data/image-descriptions')
    const writeCall = tauri.invoke.mock.calls.find((c) => c[0] === 'write_file_sync')!
    expect(writeCall[1].args[0]).toContain(`C:/data/image-descriptions/shot1.png-${fingerprint(png(1))}.md`)
    expect(writeCall[1].args[1]).toContain('A chart of monthly revenue.')
    expect(ingest.mock.calls[0][0]).toBe('t')
  })

  it('stores it with the project when the chat belongs to one', async () => {
    useImageDescription.setState({ embed: true })
    run.mockResolvedValue('desc')
    const { serviceHub, ingest, ingestProject } = hub()
    await embedImageDescriptions({ images: [image(1)], threadId: 't', projectId: 'p1', serviceHub })
    expect(ingestProject).toHaveBeenCalledWith('p1', expect.objectContaining({ type: 'document' }))
    expect(ingest).not.toHaveBeenCalled()
  })

  it('reports an image it could not make searchable and carries on with the rest', async () => {
    useImageDescription.setState({ embed: true })
    run.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce('second described')
    const { serviceHub } = hub()
    const docs = await embedImageDescriptions({ images: [image(1), image(2)], threadId: 't', serviceHub })
    expect(docs).toHaveLength(1)
    expect(docs[0].name).toBe('shot2.png (description)')
    expect(toastFn.error).toHaveBeenCalledTimes(1)
  })

  it('does nothing with no model that can see', async () => {
    useImageDescription.setState({ embed: true, enabled: false })
    const { serviceHub } = hub()
    expect(await embedImageDescriptions({ images: [image(1)], threadId: 't', serviceHub })).toEqual([])
  })
})
