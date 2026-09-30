import type { UIMessage } from 'ai'
import { toast } from 'sonner'
import { invoke } from '@tauri-apps/api/core'
import { ModelFactory } from '@/lib/model-factory'
import { runUtilityAgent } from '@/lib/utilityAgents'
import { useImageDescription } from '@/hooks/useImageDescription'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'
import type { Attachment } from '@/types/attachment'

/**
 * Images for models that cannot see them.
 *
 * A model without vision used to get nothing for an attached image: the image
 * part was stripped from the request and the model answered as if it had never
 * been sent. Here a model that can see writes a description first (what the
 * image shows and any text in it), and that text takes the image's place. The
 * same description can be stored with the conversation's documents, which is
 * how an image becomes searchable.
 *
 * The description model runs as a utility call: no tools, no authority, an
 * audit line, never shown as an agent (`utilityAgents.ts`).
 */

export type Describer = { provider: string; modelId: string }

/** Local engines: using one can mean loading a model, so it is never picked for the user. */
const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

type ProviderLike = {
  provider: string
  active?: boolean
  models: { id: string; capabilities?: string[]; embedding?: boolean }[]
}

/** Every model that can see, from providers that are switched on. */
export function visionModels(providers: readonly ProviderLike[]): Describer[] {
  const out: Describer[] = []
  for (const p of providers) {
    if (!p.active) continue
    for (const m of p.models) {
      if (m.embedding) continue
      if (m.capabilities?.includes('vision')) out.push({ provider: p.provider, modelId: m.id })
    }
  }
  return out
}

/**
 * The model that will write descriptions, or `null` when there is none (the
 * feature is off, or no model that can see is available). The user's choice
 * wins when it still exists; otherwise the first remote model that can see.
 */
export function pickDescriber(
  providers: readonly ProviderLike[],
  settings: { enabled: boolean; model: { provider: string; id: string } | null }
): Describer | null {
  if (!settings.enabled) return null
  const all = visionModels(providers)
  if (settings.model) {
    const chosen = all.find(
      (m) => m.provider === settings.model!.provider && m.modelId === settings.model!.id
    )
    if (chosen) return chosen
  }
  return all.find((m) => !LOCAL_PROVIDERS.has(m.provider)) ?? null
}

/** The describer right now, from the app's own settings and providers. */
export function currentDescriber(): Describer | null {
  return pickDescriber(useModelProvider.getState().providers ?? [], useImageDescription.getState())
}

export const DESCRIBE_PROMPT =
  'Describe this image for someone who cannot see it. Say what it shows, transcribe any visible text exactly, ' +
  'and note the details that matter for answering questions about it. Be factual and concise. Do not guess at what is not visible.'

const MAX_DESCRIPTION_TOKENS = 700
const DESCRIBE_TIMEOUT_MS = 90_000
const CACHE_LIMIT = 64

/** Descriptions already written this session, by image, so a conversation describes each image once. */
const cache = new Map<string, string>()

/** A short fingerprint of a data URL (FNV-1a over the whole string). */
export function fingerprint(dataUrl: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < dataUrl.length; i++) {
    h ^= dataUrl.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${dataUrl.length}`
}

export function clearImageDescriptionCache(): void {
  cache.clear()
}

/** Ask the describer for one image's description. Cached by image. */
export async function describeDataUrl(
  dataUrl: string,
  describer: Describer,
  opts: { session: string; signal?: AbortSignal }
): Promise<string> {
  const key = `${describer.provider}/${describer.modelId}:${fingerprint(dataUrl)}`
  const hit = cache.get(key)
  if (hit) return hit
  const provider = useModelProvider.getState().getProviderByName(describer.provider)
  if (!provider) throw new Error(`Provider ${describer.provider} not found`)
  const model = await ModelFactory.createModel(describer.modelId, provider, {})

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), DESCRIBE_TIMEOUT_MS)
  const onAbort = () => timeout.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const text = (
      await runUtilityAgent({
        kind: 'describe',
        session: opts.session,
        model,
        modelId: describer.modelId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: DESCRIBE_PROMPT },
              { type: 'image', image: dataUrl },
            ],
          },
        ],
        maxOutputTokens: MAX_DESCRIPTION_TOKENS,
        abortSignal: timeout.signal,
      })
    ).trim()
    if (!text) throw new Error('The model returned no description')
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(key, text)
    return text
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** The image parts of a message, in order, with where each sits. */
function imageParts(message: UIMessage): { index: number; url: string }[] {
  const out: { index: number; url: string }[] = []
  ;(message.parts ?? []).forEach((part, index) => {
    const p = part as { type?: string; mediaType?: string; url?: string; image?: string }
    if (p.type === 'file' && typeof p.mediaType === 'string' && p.mediaType.startsWith('image/') && p.url) {
      out.push({ index, url: p.url })
    } else if (p.type === 'image' && typeof (p.image ?? p.url) === 'string') {
      out.push({ index, url: (p.image ?? p.url) as string })
    }
  })
  return out
}

/** The text that stands in for an image in the request. */
export function descriptionPart(n: number, description: string): { type: 'text'; text: string } {
  return { type: 'text', text: `[Attached image ${n}, described because this model cannot see images]\n${description}` }
}

/**
 * Replace every image in the messages with its description, for a model that
 * cannot see. An image that cannot be described (the describer failed) is left
 * for the caller's strip step, and the failure is told to the user once.
 */
export async function describeImagesInMessages(
  messages: UIMessage[],
  describer: Describer,
  opts: { session: string; signal?: AbortSignal }
): Promise<UIMessage[]> {
  const jobs = messages.map((m) => (m.role === 'user' ? imageParts(m) : []))
  if (jobs.every((j) => j.length === 0)) return messages

  let told = false
  const results = new Map<string, string | null>()
  const describeOne = async (url: string) => {
    if (results.has(url)) return
    try {
      results.set(url, await describeDataUrl(url, describer, opts))
    } catch (e) {
      results.set(url, null)
      if (!told && !opts.signal?.aborted) {
        told = true
        toast.error(
          `Could not describe an attached image with ${describer.modelId}: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }
  // Two at a time: enough to overlap the waits, not enough to swamp a provider.
  const urls = [...new Set(jobs.flat().map((j) => j.url))]
  for (let i = 0; i < urls.length; i += 2) {
    await Promise.all(urls.slice(i, i + 2).map(describeOne))
  }

  return messages.map((message, mi) => {
    const list = jobs[mi]
    if (list.length === 0) return message
    const byIndex = new Map(list.map((j, n) => [j.index, { ...j, n: n + 1 }]))
    const parts = (message.parts ?? []).map((part, index) => {
      const job = byIndex.get(index)
      const text = job ? results.get(job.url) : undefined
      return job && text ? descriptionPart(job.n, text) : part
    })
    return { ...message, parts } as UIMessage
  })
}

/**
 * Write a description to a file the document pipeline can ingest, under the
 * app's own data folder. Returns the path.
 */
export async function writeDescriptionFile(
  dataFolder: string,
  name: string,
  description: string,
  key: string
): Promise<string> {
  const dir = `${dataFolder.replace(/[\\/]+$/, '')}/image-descriptions`
  await invoke('mkdir', { args: [dir] })
  const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'image'
  const path = `${dir}/${safe}-${key}.md`
  await invoke('write_file_sync', {
    args: [path, `# ${name}\n\nDescription of an attached image.\n\n${description}\n`],
  })
  return path
}

/**
 * Make attached images searchable: describe each one, store the description as
 * a document of the conversation (or project), and hand back the documents so
 * the message carries them. Only when the user turned this on and a model that
 * can see is available. One image failing is reported and skipped; it never
 * fails the message.
 */
export async function embedImageDescriptions(input: {
  images: readonly Attachment[]
  threadId: string
  projectId?: string
  serviceHub: ServiceHub
  signal?: AbortSignal
}): Promise<Attachment[]> {
  if (!useImageDescription.getState().embed) return []
  const describer = currentDescriber()
  const images = input.images.filter((i) => i.type === 'image' && i.dataUrl)
  if (!describer || images.length === 0) return []
  const dataFolder = await input.serviceHub.app().getJanDataFolder()
  if (!dataFolder) return []

  const out: Attachment[] = []
  for (const img of images) {
    try {
      const description = await describeDataUrl(img.dataUrl!, describer, {
        session: input.threadId,
        signal: input.signal,
      })
      const name = `${img.name} (description)`
      const path = await writeDescriptionFile(dataFolder, img.name, description, fingerprint(img.dataUrl!))
      const doc: Attachment = { name, type: 'document', path, fileType: 'md', size: description.length, parseMode: 'embeddings' }
      const res = input.projectId
        ? await input.serviceHub.uploads().ingestFileAttachmentForProject(input.projectId, doc)
        : await input.serviceHub.uploads().ingestFileAttachment(input.threadId, doc)
      out.push({
        ...doc,
        id: res.id,
        size: res.size ?? doc.size,
        chunkCount: res.chunkCount,
        processed: true,
        processing: false,
        injectionMode: 'embeddings',
      })
    } catch (e) {
      toast.error(
        `Could not make ${img.name} searchable: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  return out
}
