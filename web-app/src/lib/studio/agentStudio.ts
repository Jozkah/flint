import i18n from '@/i18n/setup'
import { studioApi, type GalleryItem, type StudioModel, type StudioStatus } from '@/lib/studio/studio'
import { isEditorConfigured, openInEditor, readEditor } from '@/lib/studio/externalEditor'
import { useStudio } from '@/hooks/useStudio'

/**
 * Studio as the chat and Cowork agents see it: list what was made (with the
 * files' absolute paths), make a picture with a model the user already
 * installed, open one in the editor the user set up. The schemas live in Rust
 * (agent-tools `tools/schemas/builtin.json`), the one list every surface
 * advertises from; the desktop answers the calls here.
 *
 * Consent: listing only reads. Generating and opening an app are in
 * `HOST_ASKED`, so every call is put to the person before it gets here.
 * Everything that can be refused is refused first (`studioPrecheck`), so the
 * person is never asked about a call that was going to fail.
 */

export const STUDIO_LIST_TOOL = 'studio_list_generations'
export const STUDIO_GENERATE_TOOL = 'studio_generate_image'
export const STUDIO_OPEN_TOOL = 'studio_open_in_editor'

export const STUDIO_TOOL_NAMES = new Set([
  STUDIO_LIST_TOOL,
  STUDIO_GENERATE_TOOL,
  STUDIO_OPEN_TOOL,
])

export const isStudioTool = (name: string): boolean => STUDIO_TOOL_NAMES.has(name)

/** Limits of the Studio screen and engine, enforced here before anyone is asked. */
export const STUDIO_LIMITS = {
  /** `diffusion_generate_image` clamps the count to 1..4. */
  maxCount: 4,
  /** `sampling_of` clamps steps to 1..100. */
  maxSteps: 100,
  /** Seeds are 32-bit in the engine. */
  maxSeed: 4_294_967_295,
  /** Every side is a multiple of this (`args::size_problem`, Studio's `snapSide`). */
  sideStep: 16,
  maxPromptChars: 4_000,
  maxListed: 50,
  defaultListed: 10,
  /** How long one call waits for the engine before it is cancelled. */
  timeoutMs: 10 * 60 * 1000,
} as const

type Result = { content?: string; error?: string }
type Args = Record<string, unknown>

const asArgs = (input: unknown): Args =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Args) : {}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/** A named integer argument within `[min, max]`, or the reason it is not. */
function intArg(args: Args, key: string, min: number, max: number): number | undefined | { error: string } {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (!isInt(v) || v < min || v > max) {
    return { error: `${key} must be a whole number from ${min} to ${max}.` }
  }
  return v
}

const failed = (r: unknown): r is { error: string } =>
  typeof r === 'object' && r !== null && 'error' in r

/**
 * The shape of the arguments, checked with no I/O. `null` when they are fine.
 * Run before the approval question and again before the work.
 */
export function studioInputError(toolName: string, input: unknown): string | null {
  const args = asArgs(input)
  if (toolName === STUDIO_LIST_TOOL) {
    const limit = intArg(args, 'limit', 1, STUDIO_LIMITS.maxListed)
    if (failed(limit)) return limit.error
    const kind = args.kind
    if (kind !== undefined && kind !== 'image' && kind !== 'video') {
      return 'kind must be "image" or "video".'
    }
    return null
  }
  if (toolName === STUDIO_GENERATE_TOOL) {
    const prompt = text(args.prompt)
    if (!prompt) return `${STUDIO_GENERATE_TOOL} needs a prompt.`
    if (prompt.length > STUDIO_LIMITS.maxPromptChars) {
      return `The prompt is longer than ${STUDIO_LIMITS.maxPromptChars} characters.`
    }
    const negative = args.negative_prompt
    if (negative !== undefined && negative !== null && typeof negative !== 'string') {
      return 'negative_prompt must be text.'
    }
    if (typeof negative === 'string' && negative.length > STUDIO_LIMITS.maxPromptChars) {
      return `The negative prompt is longer than ${STUDIO_LIMITS.maxPromptChars} characters.`
    }
    const checks = [
      intArg(args, 'count', 1, STUDIO_LIMITS.maxCount),
      intArg(args, 'steps', 1, STUDIO_LIMITS.maxSteps),
      intArg(args, 'seed', 0, STUDIO_LIMITS.maxSeed),
      intArg(args, 'width', 1, 65_535),
      intArg(args, 'height', 1, 65_535),
    ]
    for (const c of checks) if (failed(c)) return c.error
    if (args.model !== undefined && args.model !== null && typeof args.model !== 'string') {
      return 'model must be text.'
    }
    return null
  }
  if (toolName === STUDIO_OPEN_TOOL) {
    if (!text(args.id)) return `${STUDIO_OPEN_TOOL} needs \`id\`: a gallery id from ${STUDIO_LIST_TOOL}.`
    return null
  }
  return null
}

/** Directory of an absolute file path, whichever separator it uses. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : path
}

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * Studio's output folders a chat or session was told about, by conversation.
 * The agent's file tools cannot read `<data>/images` on their own (it sits in
 * Flint's data folder, which they refuse), and `request_access` refuses it
 * too. Once a conversation has been handed these paths, `agentTools` passes
 * the folder to the backend as an extra read-only folder for that
 * conversation: the one existing read grant, narrowed to just the gallery
 * folder, for just this conversation, never writable. Nothing else in the data
 * folder is reachable through it. See `studioReadFolders`.
 */
const readable = new Map<string, Set<string>>()

function allowReading(threadId: string, folder: string): void {
  if (!folder) return
  const set = readable.get(threadId) ?? new Set<string>()
  set.add(folder)
  readable.set(threadId, set)
}

/** The Studio folders to attach read-only to this conversation's file tools. */
export function studioReadFolders(threadId: string): string[] {
  return [...(readable.get(threadId) ?? [])]
}

/** Forget a conversation's folders (it ended, or a test finished). */
export function forgetStudioReadFolders(threadId?: string): void {
  if (threadId === undefined) readable.clear()
  else readable.delete(threadId)
}

const MODEL_LABEL = (m: StudioModel) => `${m.display_name} (${m.id})`

/** The installed picture models of a Studio status. */
export function installedImageModels(status: StudioStatus): StudioModel[] {
  return status.models.filter((m) => m.kind === 'image' && m.installed)
}

export type StudioPlan = {
  model: StudioModel
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  seed?: number
  count: number
}

/**
 * Which installed model a call uses and whether the sizes fit it, or why not.
 * Order: the one named; else the model Studio has loaded; else the one the
 * newest picture was made with; else the first installed one.
 */
export async function planGeneration(args: Args): Promise<StudioPlan | { error: string }> {
  const shape = studioInputError(STUDIO_GENERATE_TOOL, args)
  if (shape) return { error: shape }
  const status = await studioApi.status()
  if (!status.supported) {
    return { error: 'Picture generation is not available on this computer.' }
  }
  if (!status.engineBackend) {
    return {
      error:
        'The picture engine is not installed. Ask the user to open Studio, install the engine and a picture model, then try again.',
    }
  }
  const installed = installedImageModels(status)
  if (installed.length === 0) {
    return {
      error:
        'No picture model is installed in Studio. Ask the user to open Studio and download or add one, then try again. Nothing was generated.',
    }
  }
  const wanted = text(args.model)
  let model: StudioModel | undefined
  if (wanted) {
    const key = wanted.toLowerCase()
    model = installed.find((m) => m.id.toLowerCase() === key || m.display_name.toLowerCase() === key)
    if (!model) {
      return {
        error: `${wanted} is not an installed picture model. Installed: ${installed.map(MODEL_LABEL).join(', ')}.`,
      }
    }
  } else {
    const resident = status.resident?.kind === 'image' ? status.resident.model_id : undefined
    model = installed.find((m) => m.id === resident)
    if (!model) {
      const newest = await studioApi.gallery('image').then((g) => g[0]?.recipe.modelId, () => undefined)
      model = installed.find((m) => m.id === newest) ?? installed[0]
    }
  }
  const width = args.width as number | undefined
  const height = args.height as number | undefined
  for (const [name, side] of [['width', width], ['height', height]] as const) {
    if (side === undefined || side === null) continue
    if (side < model.min_side || side > model.max_side) {
      return { error: `${model.display_name}: the ${name} must be between ${model.min_side} and ${model.max_side}.` }
    }
    if (side % STUDIO_LIMITS.sideStep !== 0) {
      return { error: `${model.display_name}: the ${name} must be a multiple of ${STUDIO_LIMITS.sideStep}.` }
    }
  }
  return {
    model,
    prompt: String(text(args.prompt)),
    negativePrompt: text(args.negative_prompt),
    width: width ?? undefined,
    height: height ?? undefined,
    steps: (args.steps as number | undefined) ?? undefined,
    seed: (args.seed as number | undefined) ?? undefined,
    count: (args.count as number | undefined) ?? 1,
  }
}

/** The gallery picture a call names, and the editor, or why it cannot be opened. */
async function planOpen(
  args: Args
): Promise<{ item: GalleryItem; program: string; args: string } | { error: string }> {
  const shape = studioInputError(STUDIO_OPEN_TOOL, args)
  if (shape) return { error: shape }
  const editor = readEditor()
  if (!isEditorConfigured(editor)) {
    return {
      error:
        'No external editor is set up. Ask the user to choose one in Studio (Edit in external app), then try again. Nothing was opened.',
    }
  }
  const id = String(text(args.id))
  const item = (await studioApi.gallery('image')).find((g) => g.id === id)
  if (!item) {
    return { error: `There is no picture with the id ${id} in the Studio gallery. Use ${STUDIO_LIST_TOOL} for the ids.` }
  }
  return { item, program: editor.program, args: editor.args }
}

/**
 * Everything that can refuse a generating or opening call, before the person
 * is asked. `null` when the call may go on to the question.
 */
export async function studioPrecheck(toolName: string, input: unknown): Promise<string | null> {
  const args = asArgs(input)
  try {
    if (toolName === STUDIO_GENERATE_TOOL) {
      const plan = await planGeneration(args)
      return failed(plan) ? plan.error : null
    }
    if (toolName === STUDIO_OPEN_TOOL) {
      const plan = await planOpen(args)
      return failed(plan) ? plan.error : null
    }
    return studioInputError(toolName, args)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const hostText = (key: string, values?: Record<string, unknown>) =>
  i18n.t(`tools:hostApproval.${key}`, values)

/** What the approval question says a studio call will do, in the person's language. */
export async function describeStudioCall(toolName: string, input: unknown): Promise<string> {
  const args = asArgs(input)
  if (toolName === STUDIO_OPEN_TOOL) {
    const plan = await planOpen(args).catch(() => undefined)
    if (plan && !failed(plan)) {
      return hostText('studioOpen', {
        id: plan.item.id,
        prompt: plan.item.recipe.prompt.slice(0, 200),
        program: plan.program,
      })
    }
    return hostText('studioOpen', { id: String(args.id ?? ''), prompt: '', program: '' })
  }
  const plan = await planGeneration(args).catch(() => undefined)
  const model = plan && !failed(plan) ? plan.model : undefined
  const size =
    plan && !failed(plan) && plan.width && plan.height
      ? `${plan.width} x ${plan.height}`
      : model
        ? `${model.defaults.width} x ${model.defaults.height}`
        : ''
  return hostText('studioGenerate', {
    model: model?.display_name ?? text(args.model) ?? '',
    size,
    count: (plan && !failed(plan) ? plan.count : 1) as number,
    prompt: String(text(args.prompt) ?? ''),
  })
}

const iso = (ms: number): string => {
  try {
    return new Date(ms).toISOString()
  } catch {
    return ''
  }
}

function describeItem(g: GalleryItem) {
  const r = g.recipe
  return {
    id: g.id,
    kind: g.kind,
    path: g.path,
    prompt: r.prompt.slice(0, 500),
    negative_prompt: r.negativePrompt ? r.negativePrompt.slice(0, 300) : undefined,
    model: r.modelName,
    model_id: r.modelId,
    width: r.width,
    height: r.height,
    steps: r.steps,
    seed: r.seed,
    created: iso(r.createdAtMs),
    ...(g.kind === 'video' ? { frames: r.frames, fps: r.fps } : {}),
  }
}

async function runList(threadId: string, args: Args): Promise<Result> {
  const shape = studioInputError(STUDIO_LIST_TOOL, args)
  if (shape) return { error: shape }
  const limit = (args.limit as number | undefined) ?? STUDIO_LIMITS.defaultListed
  const kind = args.kind === 'video' ? 'video' : 'image'
  const all = await studioApi.gallery(kind)
  const shown = [...all].sort((a, b) => b.recipe.createdAtMs - a.recipe.createdAtMs).slice(0, limit)
  const folder = shown.length ? folderOf(shown[0].path) : undefined
  if (folder) allowReading(threadId, folder)
  return {
    content: JSON.stringify({
      status: 'ok',
      total: all.length,
      shown: shown.length,
      folder,
      note: shown.length
        ? 'Paths are absolute. They can be read with the file tools (read-only) and handed to other tools; do not write there.'
        : 'Nothing has been generated in Studio yet.',
      generations: shown.map(describeItem),
    }),
  }
}

const settle = <T>(p: Promise<T>) => p.then(() => undefined, () => undefined)

/**
 * Wait for `work`, giving up when `signal` fires (Stop) or after the timeout,
 * and in both cases telling the engine to cancel so it does not keep
 * rendering for nobody. Returns what the call should answer with.
 */
async function withCancel<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<{ ok: T } | { stopped: 'stop' | 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<'stop' | 'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    if (signal) {
      if (signal.aborted) resolve('stop')
      onAbort = () => resolve('stop')
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    const first = await Promise.race([work.then((ok) => ({ ok })), interrupted.then((stopped) => ({ stopped }))])
    if ('stopped' in first) {
      await settle(studioApi.cancel())
      // Let the engine finish unwinding, so the next call does not find it busy.
      await Promise.race([settle(work), new Promise((r) => setTimeout(r, 15_000))])
    }
    return first
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function runGenerate(threadId: string, args: Args, signal?: AbortSignal): Promise<Result> {
  const plan = await planGeneration(args)
  if (failed(plan)) return plan
  if (signal?.aborted) return { error: 'Stopped before the picture was made.' }
  const call = studioApi.generateImage({
    model: plan.model.id,
    prompt: plan.prompt,
    negative_prompt: plan.negativePrompt,
    width: plan.width,
    height: plan.height,
    steps: plan.steps,
    seed: plan.seed,
    count: plan.count,
  })
  const outcome = await withCancel(call, signal, STUDIO_LIMITS.timeoutMs)
  if ('stopped' in outcome) {
    return {
      error:
        outcome.stopped === 'stop'
          ? 'Stopped: the picture was cancelled.'
          : `The picture was not ready after ${STUDIO_LIMITS.timeoutMs / 60_000} minutes, so it was cancelled. Try a smaller size, fewer steps or fewer pictures.`,
    }
  }
  const generated = outcome.ok
  void useStudio.getState().refreshGallery('image')
  const gallery = await studioApi.gallery('image').catch(() => [] as GalleryItem[])
  const made = generated.ids.map((id, i) => {
    const found = gallery.find((g) => g.id === id)
    return found ? describeItem(found) : { id, path: generated.paths[i] }
  })
  const folder = generated.paths[0] ? folderOf(generated.paths[0]) : undefined
  if (folder) allowReading(threadId, folder)
  return {
    content: JSON.stringify({
      status: 'done',
      model: plan.model.display_name,
      seed: generated.seed,
      duration_ms: generated.duration_ms,
      folder,
      images: made,
      message: 'Saved in the Studio gallery. The paths are absolute and readable with the file tools.',
    }),
  }
}

async function runOpen(args: Args): Promise<Result> {
  const plan = await planOpen(args)
  if (failed(plan)) return plan
  await openInEditor(plan.item, { preset: 'custom', program: plan.program, args: plan.args })
  return {
    content: JSON.stringify({
      status: 'opened',
      id: plan.item.id,
      path: plan.item.path,
      editor: baseName(plan.program),
      message: 'The editor was started with this picture. Any edit the user saves is up to them.',
    }),
  }
}

/** Run one of the Studio tools for a conversation. Approval has already happened. */
export async function runStudioTool(
  toolName: string,
  input: unknown,
  threadId: string,
  options: { signal?: AbortSignal } = {}
): Promise<Result> {
  const args = asArgs(input)
  try {
    if (toolName === STUDIO_LIST_TOOL) return await runList(threadId, args)
    if (toolName === STUDIO_GENERATE_TOOL) return await runGenerate(threadId, args, options.signal)
    if (toolName === STUDIO_OPEN_TOOL) return await runOpen(args)
    return { error: `Unknown Studio tool ${toolName}.` }
  } catch (e) {
    return { error: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e) }
  }
}
