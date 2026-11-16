import { studioApi } from '@/lib/studio/studio'
import {
  generateCloudImages,
  hostedImageTargets,
  pickHostedTarget,
  type CloudTarget,
} from '@/lib/studio/cloud'
import { readLastHostedImageModel } from '@/lib/studio/lastHostedImage'
import { useModelProvider } from '@/hooks/useModelProvider'
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
 * Their schemas live in Rust (agent-tools `tools/schema.rs`), the one list every
 * surface advertises from. Pictures are named `img_1`, `img_2`, ... per
 * conversation (`chatImages.ts`);
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
  const known = listChatImages(threadId)
    .filter((i) => !i.deleted)
    .map((i) => i.id)
  return known.length
    ? `There is no picture named ${name} in this conversation. Pictures so far: ${known.join(', ')}.`
    : `There is no picture named ${name}: no picture has been made in this conversation yet.`
}

function deletedImage(name: string): string {
  return `${name} was deleted from the Studio gallery, so it can no longer be viewed or edited. Make a new picture instead.`
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

/** The longest a hosted picture request may run before it is given up on. */
const HOSTED_TIMEOUT_MS = 5 * 60 * 1000

const DEFAULT_HOSTED_SIDE = 1024

/**
 * Make or edit pictures with a hosted model, for when no local picture model
 * is loaded. Goes through the same request Studio uses, so the pictures land
 * in the gallery and are named img_N like local ones.
 */
async function makeHosted(
  threadId: string,
  target: CloudTarget,
  prompt: string,
  args: Record<string, unknown>,
  sourceGalleryIds: string[]
): Promise<Result> {
  const count = args.count === undefined ? 1 : whole(args.count)
  if (!count || count > MAX_COUNT) {
    return { error: `count must be a whole number from 1 to ${MAX_COUNT}.` }
  }
  const settings = useModelProvider
    .getState()
    .providers.find((p) => p.provider === target.provider.provider)
  if (!settings) return { error: `${target.provider.label} is not set up. Check it in Providers.` }

  const sourceImages = await Promise.all(
    sourceGalleryIds.map((id) => studioApi.media('image', id))
  )
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), HOSTED_TIMEOUT_MS)
  let generated: Awaited<ReturnType<typeof generateCloudImages>>
  try {
    generated = await generateCloudImages(
      target,
      settings,
      {
        prompt,
        width: whole(args.width) ?? DEFAULT_HOSTED_SIDE,
        height: whole(args.height) ?? DEFAULT_HOSTED_SIDE,
        count,
        sourceImages: sourceImages.length ? sourceImages : undefined,
      },
      abort.signal
    )
  } finally {
    clearTimeout(timer)
  }
  const named = addChatImages(
    threadId,
    generated.ids.map((galleryId) => ({ galleryId, prompt }))
  )
  return {
    content: JSON.stringify({
      status: 'done',
      model: target.key,
      images: named.map((n) => n.id),
      message:
        'Shown to the user. Refer to a picture by its name; use image_view to look at it.',
    }),
    images: await pictures(named),
  }
}

/** The hosted picture models set up now, with the one Studio last used. */
function hostedChoices(): { targets: CloudTarget[]; preferred: string | undefined } {
  return {
    targets: hostedImageTargets(useModelProvider.getState().providers),
    preferred: readLastHostedImageModel(),
  }
}

async function runGen(
  args: Record<string, unknown>,
  threadId: string
): Promise<Result> {
  const prompt = text(args.prompt)
  if (!prompt) return { error: `${IMAGE_GEN_TOOL} needs a prompt.` }
  const resident = await residentImageModel()
  if (!('error' in resident)) return make(threadId, prompt, {}, args, resident.modelId)
  // No local picture model: a hosted one, if the user has set one up.
  const { targets, preferred } = hostedChoices()
  if (targets.length === 0) return resident
  const picked = pickHostedTarget(targets, preferred)
  if ('error' in picked) return picked
  return makeHosted(threadId, picked.target, prompt, args, [])
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
  if (startPicture?.deleted) return { error: deletedImage(startPicture.id) }

  const names = Array.isArray(args.references)
    ? args.references.filter((r): r is string => typeof r === 'string')
    : []
  const references: ChatImage[] = []
  for (const name of names) {
    const found = findChatImage(threadId, name)
    if (!found) return { error: unknownImage(threadId, name) }
    if (found.deleted) return { error: deletedImage(found.id) }
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
  if ('error' in resident) {
    // No local picture model: a hosted one that takes edits, if set up.
    const { targets, preferred } = hostedChoices()
    if (targets.length === 0) return resident
    const editors = targets.filter((t) => t.provider.jsonEdits)
    if (editors.length === 0) {
      return {
        error:
          'Editing a picture needs an image model loaded in Studio: the hosted image models set up here cannot edit pictures yet. Generate a new picture instead, or ask the user to load a local one.',
      }
    }
    const picked = pickHostedTarget(editors, preferred)
    if ('error' in picked) return picked
    return makeHosted(
      threadId,
      picked.target,
      prompt,
      args,
      [startPicture, ...references].filter((p): p is ChatImage => !!p).map((p) => p.galleryId)
    )
  }
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
  if (found.deleted) return { error: deletedImage(found.id) }
  let image: ToolImage
  try {
    image = await pictureOf(found.galleryId, found.id)
  } catch {
    return {
      error: deletedImage(found.id),
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
