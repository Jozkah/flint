import { studioApi } from '@/lib/studio/studio'
import type { ToolImage } from '@/lib/toolOutputImages'
import {
  addChatImages,
  findChatImage,
  listChatImages,
  type ChatImage,
} from '@/lib/chatImages'

/**
 * Picture tools for a chat with a text model: it can make a picture
 * (`image_gen`), change one (`image_edit`) and look at one (`image_view`).
 * Pictures are named `img_1`, `img_2`, ... per conversation (`chatImages.ts`);
 * the pixels stay in the Studio gallery and are never swapped out by a call,
 * because these never load a model: they use the one resident in Studio.
 */

export const IMAGE_GEN_TOOL = 'image_gen'
export const IMAGE_EDIT_TOOL = 'image_edit'
export const IMAGE_VIEW_TOOL = 'image_view'

export const IMAGE_TOOL_NAMES = new Set([
  IMAGE_GEN_TOOL,
  IMAGE_EDIT_TOOL,
  IMAGE_VIEW_TOOL,
])

export const isImageTool = (name: string): boolean => IMAGE_TOOL_NAMES.has(name)

/** One shape for both outcomes, as the chat's tool dispatcher reads it. */
type Result = { content?: string; images?: ToolImage[]; error?: string }

const MAX_COUNT = 4
const DEFAULT_EDIT_STRENGTH = 0.6

export type ImageToolSchema = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const SIZE_PROPS = {
  width: {
    type: 'integer',
    description: 'Width in pixels, a multiple of 16. Omit for the default.',
  },
  height: {
    type: 'integer',
    description: 'Height in pixels, a multiple of 16. Omit for the default.',
  },
  count: {
    type: 'integer',
    description: `How many pictures to make, 1 to ${MAX_COUNT}. Default 1.`,
  },
  seed: { type: 'integer', description: 'Seed, for a repeatable result.' },
}

export function imageToolSchemas(): ImageToolSchema[] {
  return [
    {
      type: 'function',
      function: {
        name: IMAGE_GEN_TOOL,
        description:
          'Make a picture from a text description with the image model loaded in Studio. ' +
          'Each picture is shown to the user and named img_1, img_2, ...; use those names with ' +
          `${IMAGE_VIEW_TOOL} and ${IMAGE_EDIT_TOOL}. Fails if no image model is loaded.`,
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'What the picture should show.',
            },
            negative_prompt: {
              type: 'string',
              description: 'What to keep out of the picture.',
            },
            ...SIZE_PROPS,
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: IMAGE_EDIT_TOOL,
        description:
          'Change a picture made earlier in this conversation. `image` is the one to start from ' +
          '(image-to-image: `strength` says how much it may change). `references` are pictures an ' +
          'instruction-edit model should follow ("put this logo on that shirt"). Give `image`, ' +
          '`references`, or both. The result is a new picture with its own name; the original is kept.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'What the result should look like, or the change to make.',
            },
            image: {
              type: 'string',
              description: 'Name of the picture to start from, like img_1.',
            },
            strength: {
              type: 'number',
              description: `0 keeps the picture, 1 ignores it. Default ${DEFAULT_EDIT_STRENGTH}. Only used with \`image\`.`,
            },
            references: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of pictures to follow, like ["img_1", "img_2"].',
            },
            negative_prompt: { type: 'string' },
            ...SIZE_PROPS,
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: IMAGE_VIEW_TOOL,
        description:
          'Look at a picture made earlier in this conversation, for example to check a result ' +
          'before describing it or editing it again. Takes the name from image_gen or image_edit.',
        parameters: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: 'Name of the picture, like img_1.',
            },
          },
          required: ['image'],
        },
      },
    },
  ]
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

const whole = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' ? (input as Record<string, unknown>) : {}

/** The model Studio has loaded, or the reason none can be used. */
async function residentImageModel(): Promise<
  { modelId: string } | { error: string }
> {
  const status = await studioApi.status()
  if (!status.supported) {
    return { error: 'The image engine is not available on this computer.' }
  }
  const resident = status.resident
  if (!resident || resident.kind !== 'image') {
    return {
      error:
        'No image model is loaded. Ask the user to load one in Studio, then try again.',
    }
  }
  return { modelId: resident.model_id }
}

function unknownImage(threadId: string, name: string): string {
  const known = listChatImages(threadId).map((i) => i.id)
  return known.length
    ? `There is no picture named ${name} in this conversation. Pictures so far: ${known.join(', ')}.`
    : `There is no picture named ${name}: no picture has been made in this conversation yet.`
}

async function pictureOf(galleryId: string, name: string): Promise<ToolImage> {
  return { dataUrl: await studioApi.media('image', galleryId), name: `${name}.png` }
}

async function pictures(made: readonly ChatImage[]): Promise<ToolImage[]> {
  return Promise.all(made.map((m) => pictureOf(m.galleryId, m.id)))
}

type MakeParams = Parameters<typeof studioApi.generateImage>[0]

async function make(
  threadId: string,
  prompt: string,
  extra: Partial<MakeParams>,
  args: Record<string, unknown>,
  modelId: string
): Promise<Result> {
  const count = args.count === undefined ? 1 : whole(args.count)
  if (!count || count > MAX_COUNT) {
    return { error: `count must be a whole number from 1 to ${MAX_COUNT}.` }
  }
  const generated = await studioApi.generateImage({
    model: modelId,
    prompt,
    negative_prompt: text(args.negative_prompt),
    width: whole(args.width),
    height: whole(args.height),
    count,
    seed: whole(args.seed),
    ...extra,
  })
  const named = addChatImages(
    threadId,
    generated.ids.map((galleryId) => ({ galleryId, prompt }))
  )
  return {
    content: JSON.stringify({
      status: 'done',
      model: modelId,
      seed: generated.seed,
      images: named.map((n) => n.id),
      message:
        'Shown to the user. Refer to a picture by its name; use image_view to look at it.',
    }),
    images: await pictures(named),
  }
}

async function runGen(
  args: Record<string, unknown>,
  threadId: string
): Promise<Result> {
  const prompt = text(args.prompt)
  if (!prompt) return { error: `${IMAGE_GEN_TOOL} needs a prompt.` }
  const resident = await residentImageModel()
  if ('error' in resident) return resident
  return make(threadId, prompt, {}, args, resident.modelId)
}

async function runEdit(
  args: Record<string, unknown>,
  threadId: string
): Promise<Result> {
  const prompt = text(args.prompt)
  if (!prompt) return { error: `${IMAGE_EDIT_TOOL} needs a prompt.` }

  const start = text(args.image)
  const startPicture = start ? findChatImage(threadId, start) : undefined
  if (start && !startPicture) return { error: unknownImage(threadId, start) }

  const names = Array.isArray(args.references)
    ? args.references.filter((r): r is string => typeof r === 'string')
    : []
  const references: ChatImage[] = []
  for (const name of names) {
    const found = findChatImage(threadId, name)
    if (!found) return { error: unknownImage(threadId, name) }
    references.push(found)
  }
  if (!startPicture && references.length === 0) {
    return {
      error: `${IMAGE_EDIT_TOOL} needs \`image\` or \`references\`: the name of a picture made in this conversation.`,
    }
  }

  const strength =
    args.strength === undefined ? DEFAULT_EDIT_STRENGTH : Number(args.strength)
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    return { error: 'strength must be a number from 0 to 1.' }
  }

  const resident = await residentImageModel()
  if ('error' in resident) return resident
  return make(
    threadId,
    prompt,
    {
      init_image_id: startPicture?.galleryId,
      strength: startPicture ? strength : undefined,
      reference_ids: references.map((r) => r.galleryId),
    },
    args,
    resident.modelId
  )
}

async function runView(
  args: Record<string, unknown>,
  threadId: string
): Promise<Result> {
  const name = text(args.image)
  if (!name) return { error: `${IMAGE_VIEW_TOOL} needs \`image\`: a picture name like img_1.` }
  const found = findChatImage(threadId, name)
  if (!found) return { error: unknownImage(threadId, name) }
  let image: ToolImage
  try {
    image = await pictureOf(found.galleryId, found.id)
  } catch {
    return {
      error: `${found.id} is no longer in the Studio gallery (it was deleted).`,
    }
  }
  return {
    content: JSON.stringify({ image: found.id, prompt: found.prompt }),
    images: [image],
  }
}

/** Run one of the picture tools for a conversation. */
export async function runImageTool(
  toolName: string,
  input: unknown,
  threadId: string
): Promise<Result> {
  const args = asRecord(input)
  try {
    if (toolName === IMAGE_GEN_TOOL) return await runGen(args, threadId)
    if (toolName === IMAGE_EDIT_TOOL) return await runEdit(args, threadId)
    if (toolName === IMAGE_VIEW_TOOL) return await runView(args, threadId)
    return { error: `Unknown picture tool ${toolName}.` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
