import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { getServiceHub } from '@/hooks/useServiceHub'
import { allowNotifications, notifyInBackground } from '@/lib/notify'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  studioApi,
  type EngineBuild,
  type GalleryItem,
  type StudioKind,
  type StudioModel,
  type StudioStatus,
} from '@/lib/studio/studio'
import { downloadedBytes, parseDownloadTask } from '@/lib/studio/helpers'

type Job = { kind: StudioKind; phase: string; fraction: number; startedAt: number; remote?: string }

/** What this session has asked for, newest first: the Activity list on the page. */
export type StudioActivity = {
  id: number
  kind: StudioKind
  prompt: string
  status: 'done' | 'failed' | 'stopped'
  error?: string
  durationMs: number
  at: number
}

const ACTIVITY_LIMIT = 12
let activityId = 0

/** Stops the hosted request in flight, if the running job is one. */
let remoteAbort: AbortController | null = null

type StudioState = {
  status: StudioStatus | null
  error: string | null
  installing: { stage: string; downloaded: number; total: number } | null
  download: { modelId: string; bytes: number; total: number } | null
  gallery: Record<StudioKind, GalleryItem[]>
  job: Job | null
  jobPrompt: string
  activity: StudioActivity[]
  refresh: () => Promise<void>
  refreshGallery: (kind: StudioKind) => Promise<void>
  installEngine: (build: EngineBuild) => Promise<void>
  downloadModel: (model: StudioModel) => Promise<void>
  load: (modelId: string) => Promise<void>
  unload: () => Promise<void>
  generate: (
    kind: StudioKind,
    prompt: string,
    run: () => Promise<unknown>,
    remote?: { label: string; abort: AbortController }
  ) => Promise<boolean>
  cancel: () => Promise<void>
  remove: (kind: StudioKind, id: string) => Promise<void>
  removeCustomModel: (modelId: string) => Promise<void>
  clearError: () => void
}

const message = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)

let listening = false
function listenOnce(): void {
  if (listening) return
  listening = true
  void listen<{ job_id: string; phase: string; fraction: number }>('diffusion-progress', ({ payload }) => {
    const job = useStudio.getState().job
    if (job) {
      useStudio.setState({ job: { ...job, phase: payload.phase, fraction: payload.fraction } })
    }
  })
  void listen<{ stage: string; downloaded: number; total: number }>('diffusion-install-progress', ({ payload }) => {
    useStudio.setState({
      installing: { stage: payload.stage, downloaded: payload.downloaded, total: payload.total },
    })
  })
  void listen('diffusion-state', () => {
    void useStudio.getState().refresh()
  })
  void listen<{ taskId: string; downloaded: number }>('huggingface-download-progress', ({ payload }) => {
    // The downloader serialises this event in camelCase.
    const task = parseDownloadTask(payload.taskId)
    if (!task) return
    const model = useStudio.getState().status?.models.find((m) => m.id === task.modelId)
    if (!model) return
    useStudio.setState({
      download: {
        modelId: model.id,
        bytes: downloadedBytes(model.files, task.index, payload.downloaded),
        total: model.totalBytes,
      },
    })
  })
}

export const useStudio = create<StudioState>((set, get) => ({
  status: null,
  error: null,
  installing: null,
  download: null,
  gallery: { image: [], video: [] },
  job: null,
  jobPrompt: '',
  activity: [],

  refresh: async () => {
    listenOnce()
    try {
      set({ status: await studioApi.status() })
    } catch (error) {
      set({ error: message(error) })
    }
  },

  refreshGallery: async (kind) => {
    try {
      const items = await studioApi.gallery(kind)
      set((s) => ({ gallery: { ...s.gallery, [kind]: items } }))
    } catch (error) {
      set({ error: message(error) })
    }
  },

  installEngine: async (build) => {
    set({ error: null, installing: { stage: 'download', downloaded: 0, total: 0 } })
    try {
      await studioApi.installEngine(build)
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ installing: null })
      await get().refresh()
    }
  },

  downloadModel: async (model) => {
    void allowNotifications()
    set({ error: null, download: { modelId: model.id, bytes: 0, total: model.totalBytes } })
    try {
      await studioApi.downloadModel(model.id, useGeneralSetting.getState().huggingfaceToken)
      notifyInBackground(`${model.display_name} is downloaded`)
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ download: null })
      await get().refresh()
    }
  },

  load: async (modelId) => {
    set({ error: null })
    try {
      // The chat model and the image model do not both fit on most GPUs.
      await getServiceHub().models().stopAllModels()
      await studioApi.load(modelId)
    } catch (error) {
      set({ error: message(error) })
    } finally {
      await get().refresh()
    }
  },

  unload: async () => {
    try {
      await studioApi.unload()
    } finally {
      await get().refresh()
    }
  },

  generate: async (kind, prompt, run, remote) => {
    if (get().job) return false
    const startedAt = Date.now()
    void allowNotifications()
    remoteAbort = remote?.abort ?? null
    set({
      error: null,
      jobPrompt: prompt,
      job: { kind, phase: remote ? 'remote' : 'queued', fraction: 0, startedAt, remote: remote?.label },
    })
    const log = (status: StudioActivity['status'], error?: string) =>
      set((s) => ({
        activity: [
          { id: ++activityId, kind, prompt, status, error, durationMs: Date.now() - startedAt, at: Date.now() },
          ...s.activity,
        ].slice(0, ACTIVITY_LIMIT),
      }))
    try {
      // A hosted provider does not use this computer's graphics card, so the
      // chat models stay loaded.
      if (!remote) await getServiceHub().models().stopAllModels().catch(() => undefined)
      await run()
      await get().refreshGallery(kind)
      log('done')
      notifyInBackground(kind === 'video' ? 'Your video is ready' : 'Your image is ready', prompt)
      return true
    } catch (error) {
      const text = message(error)
      if (text === 'Cancelled.' || remote?.abort.signal.aborted) {
        log('stopped')
      } else {
        set({ error: text })
        log('failed', text)
      }
      return false
    } finally {
      remoteAbort = null
      set({ job: null })
      await get().refresh()
    }
  },

  cancel: async () => {
    if (remoteAbort) {
      remoteAbort.abort()
      return
    }
    try {
      await studioApi.cancel()
    } catch (error) {
      set({ error: message(error) })
    }
  },

  removeCustomModel: async (modelId) => {
    try {
      await studioApi.removeCustomModel(modelId)
    } catch (error) {
      set({ error: message(error) })
    } finally {
      await get().refresh()
    }
  },

  remove: async (kind, id) => {
    try {
      await studioApi.remove(kind, id)
      await get().refreshGallery(kind)
    } catch (error) {
      set({ error: message(error) })
    }
  },

  clearError: () => set({ error: null }),
}))
