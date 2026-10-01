// The app's side of Studio and dictation for phones: the same store and
// commands the desktop's Studio page and voice button use.

import { RemoteRpcError } from './bridge'
import type { RemoteEmit } from './events'
import type { RemoteStudio, RemoteVoice, StudioRequest } from './studio'
import type { StudioActivityWire, StudioJobWire, StudioKindWire } from './protocol'
import { useStudio } from '@/hooks/useStudio'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getServiceHub } from '@/hooks/useServiceHub'
import { studioApi, type GalleryItem, type StudioModel } from '@/lib/studio/studio'
import {
  IMAGE_SIZES,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  framesForSeconds,
  videoMemoryWarning,
} from '@/lib/studio/helpers'
import { VOICE_MODEL_ID } from '@/lib/voice/voiceModel'
import { transcribeWav } from '@/lib/voice/transcribe'

/** Images in the job a phone (or the desktop) started; the store does not keep it. */
let jobCount = 1

async function totalMemoryMb(): Promise<number | undefined> {
  const known = useHardware.getState().hardwareData.total_memory
  if (known) return known
  const data = await getServiceHub().hardware().getHardwareInfo().catch(() => null)
  if (data) useHardware.getState().setHardwareData(data)
  return data?.total_memory || undefined
}

function jobWire(): StudioJobWire | null {
  const { job, jobPrompt } = useStudio.getState()
  if (!job) return null
  return {
    kind: job.kind,
    prompt: jobPrompt,
    phase: job.phase,
    fraction: job.fraction,
    startedAt: job.startedAt,
    count: job.kind === 'image' ? jobCount : 1,
  }
}

async function freshStatus() {
  await useStudio.getState().refresh()
  const status = useStudio.getState().status
  if (!status) throw new RemoteRpcError('unavailable', 'Studio could not be read')
  return status
}

/** The loaded model of `kind`, or a clear reason to load one. */
async function residentModel(kind: StudioKindWire): Promise<StudioModel> {
  const status = await freshStatus()
  if (!status.supported) throw new RemoteRpcError('unsupported', 'Studio is not available on this computer yet')
  const model = status.models.find((m) => m.id === status.resident?.model_id && m.kind === kind)
  if (!model) throw new RemoteRpcError('not_ready', `Load ${kind === 'video' ? 'a video' : 'an image'} model first`)
  return model
}

function start(
  kind: StudioKindWire,
  prompt: string,
  count: number,
  run: () => Promise<unknown>
) {
  if (useStudio.getState().job) throw new RemoteRpcError('busy', 'Studio is already making something')
  jobCount = count
  void useStudio.getState().generate(kind, prompt, run)
}

async function generate(req: StudioRequest): Promise<void> {
  const model = await residentModel(req.kind)
  if (req.kind === 'video' && !req.memoryAcknowledged && videoMemoryWarning(await totalMemoryMb())) {
    throw new RemoteRpcError('memory_warning', 'Acknowledge the memory warning first')
  }
  const sizes = req.kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES
  const size = sizes[Math.min(req.sizeIndex, sizes.length - 1)]
  const common = {
    model: model.id,
    prompt: req.prompt,
    negative_prompt: req.negative,
    width: size.width,
    height: size.height,
    seed: req.seed,
  }
  start(req.kind, req.prompt, req.kind === 'image' ? req.count : 1, () =>
    req.kind === 'video'
      ? studioApi.generateVideo({ ...common, frames: framesForSeconds(req.seconds, model.video?.fps ?? 24) })
      : studioApi.generateImage({ ...common, count: req.count })
  )
}

async function findItem(kind: StudioKindWire, id: string): Promise<GalleryItem | undefined> {
  return (await studioApi.gallery(kind)).find((i) => i.id === id)
}

export const appStudio: RemoteStudio = {
  async status() {
    const status = await freshStatus()
    const s = useStudio.getState()
    const mb = await totalMemoryMb()
    const activity: StudioActivityWire[] = s.activity.map((a) => ({ ...a }))
    const job = jobWire()
    if (job) {
      activity.unshift({ id: 0, kind: job.kind, prompt: job.prompt, status: 'making', durationMs: Date.now() - job.startedAt, at: job.startedAt })
    }
    return {
      supported: status.supported,
      engineTag: status.engineTag,
      engineBackend: status.engineBackend,
      models: status.models.map((m) => ({
        id: m.id,
        name: m.display_name,
        kind: m.kind,
        installed: m.installed,
        totalBytes: m.totalBytes,
        fps: m.video?.fps ?? null,
      })),
      resident: status.resident
        ? { modelId: status.resident.model_id, kind: status.resident.kind, busy: status.resident.busy }
        : null,
      job,
      download: s.download,
      activity,
      memoryWarning: videoMemoryWarning(mb),
      memoryGb: mb ? Math.round(mb / 1024) : null,
      error: s.error,
      sizes: {
        image: IMAGE_SIZES.map(({ label, short }) => ({ label, short })),
        video: VIDEO_SIZES.map(({ label, short }) => ({ label, short })),
      },
      videoSeconds: VIDEO_SECONDS,
    }
  },
  async load(modelId) {
    await useStudio.getState().load(modelId)
  },
  async unload() {
    await useStudio.getState().unload()
  },
  async download(modelId) {
    const model = (await freshStatus()).models.find((m) => m.id === modelId)
    if (!model) throw new RemoteRpcError('not_found', 'No such model')
    void useStudio.getState().downloadModel(model)
  },
  generate,
  async stop() {
    await useStudio.getState().cancel()
  },
  async gallery(kind) {
    await useStudio.getState().refreshGallery(kind)
    return useStudio.getState().gallery[kind].map((i) => ({
      id: i.id,
      kind: i.kind,
      recipe: {
        prompt: i.recipe.prompt,
        negativePrompt: i.recipe.negativePrompt,
        width: i.recipe.width,
        height: i.recipe.height,
        seed: i.recipe.seed,
        modelName: i.recipe.modelName,
        frames: i.recipe.frames,
        fps: i.recipe.fps,
        createdAtMs: i.recipe.createdAtMs,
        durationMs: i.recipe.durationMs,
      },
    }))
  },
  async media(kind, id) {
    // The desktop resolves the id inside its own gallery folder.
    return (await findItem(kind, id)) ? studioApi.media(kind, id) : null
  },
  async remix(kind, id) {
    const item = await findItem(kind, id)
    if (!item) return false
    const model = await residentModel(kind)
    const r = item.recipe
    const common = {
      model: model.id,
      prompt: r.prompt,
      negative_prompt: r.negativePrompt || undefined,
      width: r.width,
      height: r.height,
    }
    start(kind, r.prompt, 1, () =>
      kind === 'video'
        ? studioApi.generateVideo({ ...common, frames: r.frames ?? undefined })
        : studioApi.generateImage({ ...common, count: 1 })
    )
    return true
  },
  async remove(kind, id) {
    await useStudio.getState().remove(kind, id)
  },
}

export const appVoice: RemoteVoice = {
  ready: () =>
    !!useModelProvider
      .getState()
      .providers.find((p) => p.provider === 'llamacpp')
      ?.models.some((m) => m.id === VOICE_MODEL_ID),
  transcribe: (wav, language) => transcribeWav(wav, { language }),
}

/** Forwards Studio's progress and changes to phones; returns the stop function. */
/** Calls `fn` at most once per `ms`, trailing; `now` skips the wait. */
function throttled(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = 0
  const fire = () => {
    timer = null
    last = Date.now()
    fn()
  }
  return {
    call(now = false) {
      if (now) {
        if (timer) clearTimeout(timer)
        fire()
      } else if (!timer) timer = setTimeout(fire, Math.max(0, ms - (Date.now() - last)))
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  }
}

/** Forwards Studio's progress and changes to phones; returns the stop function. */
export function startStudioForwarding(emit: RemoteEmit): () => void {
  const progress = throttled(() => emit({ type: 'studio.progress', job: jobWire() }), 500)
  const updated = throttled(() => emit({ type: 'studio.updated' }), 1000)
  const off = useStudio.subscribe((s, prev) => {
    // A job starting or ending goes now; progress at most twice a second.
    if (s.job !== prev.job) progress.call(!s.job || !prev.job)
    if (
      s.activity !== prev.activity ||
      s.gallery !== prev.gallery ||
      s.status !== prev.status ||
      s.download !== prev.download ||
      s.error !== prev.error
    ) {
      updated.call()
    }
  })
  return () => {
    off()
    progress.cancel()
    updated.cancel()
  }
}
