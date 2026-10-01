import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { getServiceHub } from '@/hooks/useServiceHub'
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

type Job = { kind: StudioKind; phase: string; fraction: number; startedAt: number }

type StudioState = {
  status: StudioStatus | null
  error: string | null
  installing: { stage: string; downloaded: number; total: number } | null
  download: { modelId: string; bytes: number; total: number } | null
  gallery: Record<StudioKind, GalleryItem[]>
  job: Job | null
  refresh: () => Promise<void>
  refreshGallery: (kind: StudioKind) => Promise<void>
  installEngine: (build: EngineBuild) => Promise<void>
  downloadModel: (model: StudioModel) => Promise<void>
  load: (modelId: string) => Promise<void>
  unload: () => Promise<void>
  generate: (kind: StudioKind, run: () => Promise<unknown>) => Promise<boolean>
  cancel: () => Promise<void>
  remove: (kind: StudioKind, id: string) => Promise<void>
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
  void listen<{ task_id: string; downloaded: number }>('huggingface-download-progress', ({ payload }) => {
    const task = parseDownloadTask(payload.task_id)
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
    set({ error: null, download: { modelId: model.id, bytes: 0, total: model.totalBytes } })
    try {
      await studioApi.downloadModel(model.id, useGeneralSetting.getState().huggingfaceToken)
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

  generate: async (kind, run) => {
    if (get().job) return false
    set({ error: null, job: { kind, phase: 'queued', fraction: 0, startedAt: Date.now() } })
    try {
      await getServiceHub().models().stopAllModels().catch(() => undefined)
      await run()
      await get().refreshGallery(kind)
      return true
    } catch (error) {
      const text = message(error)
      if (text !== 'Cancelled.') set({ error: text })
      return false
    } finally {
      set({ job: null })
      await get().refresh()
    }
  },

  cancel: async () => {
    try {
      await studioApi.cancel()
    } catch (error) {
      set({ error: message(error) })
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
