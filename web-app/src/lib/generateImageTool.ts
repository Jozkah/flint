import { studioApi } from '@/lib/studio/studio'
import type { ToolImage } from '@/lib/toolOutputImages'

type Result = { content: string; images?: ToolImage[] } | { error: string }

const MAX_COUNT = 4

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

const whole = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined

/**
 * `generate_image`: make a picture with the image model resident in Studio.
 * Never loads a model, so a call cannot swap out one the user is using; the
 * images come back for the conversation to show and for a vision model to see.
 */
export async function runGenerateImage(input: unknown): Promise<Result> {
  const args =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const prompt = text(args.prompt)
  if (!prompt) return { error: 'generate_image needs a prompt.' }
  const count = args.count === undefined ? 1 : whole(args.count)
  if (!count || count > MAX_COUNT) {
    return { error: `count must be a whole number from 1 to ${MAX_COUNT}.` }
  }
  try {
    const status = await studioApi.status()
    const resident = status.resident
    if (!status.supported) {
      return { error: 'The image engine is not available on this computer.' }
    }
    if (!resident || resident.kind !== 'image') {
      return {
        error:
          'No image model is loaded. Ask the user to load one in Studio, then try again.',
      }
    }
    const generated = await studioApi.generateImage({
      model: resident.model_id,
      prompt,
      negative_prompt: text(args.negative_prompt),
      width: whole(args.width),
      height: whole(args.height),
      count,
      seed: whole(args.seed),
    })
    const images: ToolImage[] = await Promise.all(
      generated.ids.map(async (id, i) => ({
        dataUrl: await studioApi.media('image', id),
        name: `image-${i + 1}.png`,
      }))
    )
    return {
      content: JSON.stringify({
        status: 'generated',
        model: resident.model_id,
        count: images.length,
        seed: generated.seed,
        message: 'Shown to the user. The pictures are kept in the Studio gallery.',
      }),
      images,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
