import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'

/**
 * Image output from chat models behind OpenRouter. Image-generating models
 * (Gemini image, GPT image, ...) return pictures in `message.images` /
 * `delta.images` as `{ type: 'image_url', image_url: { url: 'data:...' } }`.
 * @ai-sdk/openai-compatible drops that field, so a fetch tap records it and a
 * model middleware turns it into `file` parts, which the chat already renders
 * and persists as images.
 */

type Json = Record<string, unknown>

export type OutputImage = { mediaType: string; base64: string }

export function parseImageDataUrl(url: unknown): OutputImage | undefined {
  if (typeof url !== 'string') return undefined
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url)
  return m ? { mediaType: m[1]!.toLowerCase(), base64: m[2]! } : undefined
}

export class ImageTap {
  images: OutputImage[] = []
  private seen = new Set<string>()

  reset(): void {
    this.images = []
    this.seen.clear()
  }

  add(choice: Json | undefined): void {
    const holder = (choice?.delta ?? choice?.message) as Json | undefined
    const list = holder?.images
    if (!Array.isArray(list)) return
    for (const item of list as Json[]) {
      const url = (item?.image_url as Json | undefined)?.url ?? item?.url
      const img = parseImageDataUrl(url)
      if (!img || this.seen.has(img.base64)) continue
      this.seen.add(img.base64)
      this.images.push(img)
    }
  }
}

function feedSseLine(tap: ImageTap, line: string): void {
  if (!line.startsWith('data:')) return
  const payload = line.slice(5).trim()
  if (!payload || payload === '[DONE]') return
  try {
    const json = JSON.parse(payload) as Json
    tap.add((json.choices as Json[] | undefined)?.[0])
  } catch {
    // partial or non-JSON event: ignore
  }
}

export function withImageTap(
  inner: typeof globalThis.fetch,
  tap: ImageTap
): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await inner(input, init)
    if (!res.ok || !res.body) return res
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      const decoder = new TextDecoder()
      let buf = ''
      const pipe = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk)
          buf += decoder.decode(chunk, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const l of lines) feedSseLine(tap, l.trim())
        },
        flush() {
          if (buf) feedSseLine(tap, buf.trim())
        },
      })
      return new Response(res.body.pipeThrough(pipe), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    }
    if (type.includes('json')) {
      try {
        const json = (await res.clone().json()) as Json
        tap.add((json.choices as Json[] | undefined)?.[0])
      } catch {
        // unreadable body: nothing to record
      }
    }
    return res
  }
}

const toFilePart = (img: OutputImage) =>
  ({ type: 'file', mediaType: img.mediaType, data: img.base64 }) as const

/** Emits the tapped images as file parts just before the stream finishes. */
export function imageOutputMiddleware(
  tap: ImageTap
): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapStream: async ({ doStream }) => {
      tap.reset()
      const { stream, ...rest } = await doStream()
      const out = stream.pipeThrough(
        new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
          transform(part, controller) {
            if (part.type === 'finish') {
              for (const img of tap.images) controller.enqueue(toFilePart(img))
              tap.reset()
            }
            controller.enqueue(part)
          },
        })
      )
      return { stream: out, ...rest }
    },
    wrapGenerate: async ({ doGenerate }) => {
      tap.reset()
      const result = await doGenerate()
      const files = tap.images.map(toFilePart)
      tap.reset()
      return files.length
        ? { ...result, content: [...result.content, ...files] }
        : result
    },
  }
}
