import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import {
  cancelHuggingFaceDownload,
  downloadHuggingFaceFile,
  type HuggingFaceDownloadProgress,
  type HuggingFaceFile,
} from '@/lib/huggingface'

export type HuggingFaceTaskStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'importing'
  | 'complete'
  | 'cancelled'
  | 'error'

export type HuggingFaceDownloadTask = {
  id: string
  repo: string
  label: string
  status: HuggingFaceTaskStatus
  files: HuggingFaceFile[]
  paths: string[]
  currentFileIndex: number
  currentTaskId?: string
  downloaded: number
  total?: number
  progress: number
  error?: string
}

type DownloadStore = {
  tasks: Record<string, HuggingFaceDownloadTask>
  upsert: (task: HuggingFaceDownloadTask) => void
  patch: (id: string, patch: Partial<HuggingFaceDownloadTask>) => void
  remove: (id: string) => void
}

export const useHuggingFaceDownloads = create<DownloadStore>((set) => ({
  tasks: {},
  upsert: (task) => set((state) => ({ tasks: { ...state.tasks, [task.id]: task } })),
  patch: (id, patch) =>
    set((state) => {
      const current = state.tasks[id]
      if (!current) return state
      return { tasks: { ...state.tasks, [id]: { ...current, ...patch } } }
    }),
  remove: (id) =>
    set((state) => {
      const tasks = { ...state.tasks }
      delete tasks[id]
      return { tasks }
    }),
}))

type BundleRunner = {
  id: string
  repo: string
  label: string
  files: HuggingFaceFile[]
  token?: string
  onComplete?: (paths: string[]) => Promise<void>
}

const runners = new Map<string, BundleRunner>()
const running = new Set<string>()
const pauseIntent = new Set<string>()
const cancelIntent = new Set<string>()
let progressListener: Promise<() => void> | null = null

function totalBytes(files: HuggingFaceFile[]): number | undefined {
  if (!files.length || files.some((file) => typeof file.size !== 'number')) return undefined
  return files.reduce((sum, file) => sum + (file.size ?? 0), 0)
}

function completedBytes(files: HuggingFaceFile[], count: number): number {
  return files.slice(0, count).reduce((sum, file) => sum + (file.size ?? 0), 0)
}

function ensureProgressListener() {
  if (progressListener) return progressListener
  progressListener = listen<HuggingFaceDownloadProgress>(
    'huggingface-download-progress',
    ({ payload }) => {
      const store = useHuggingFaceDownloads.getState()
      const task = Object.values(store.tasks).find(
        (candidate) => candidate.currentTaskId === payload.taskId
      )
      if (!task) return
      const base = completedBytes(task.files, task.currentFileIndex)
      const downloaded = base + payload.downloaded
      const total = task.total ??
        (payload.total != null
          ? base + payload.total + completedBytes(task.files.slice(task.currentFileIndex + 1), task.files.length)
          : undefined)
      store.patch(task.id, {
        downloaded,
        total,
        progress: total && total > 0 ? Math.min(1, downloaded / total) : task.progress,
      })
    }
  ).catch(() => () => {})
  return progressListener
}

async function runBundle(id: string): Promise<void> {
  if (running.has(id)) return
  const runner = runners.get(id)
  if (!runner) throw new Error('Download cannot be resumed after Flint restarts. Start it again to reuse the partial file.')
  running.add(id)
  pauseIntent.delete(id)
  cancelIntent.delete(id)
  await ensureProgressListener()

  const store = useHuggingFaceDownloads.getState()
  const existing = store.tasks[id]
  const paths = existing?.paths ? [...existing.paths] : []
  const startAt = Math.min(paths.length, runner.files.length)
  const total = totalBytes(runner.files)

  if (!existing) {
    store.upsert({
      id,
      repo: runner.repo,
      label: runner.label,
      status: 'queued',
      files: runner.files,
      paths,
      currentFileIndex: startAt,
      downloaded: completedBytes(runner.files, startAt),
      total,
      progress: total ? completedBytes(runner.files, startAt) / total : 0,
    })
  } else {
    store.patch(id, { status: 'queued', error: undefined, total })
  }

  try {
    for (let index = startAt; index < runner.files.length; index++) {
      const file = runner.files[index]
      const nativeTaskId = `${id}:${index}`
      store.patch(id, {
        status: 'downloading',
        currentFileIndex: index,
        currentTaskId: nativeTaskId,
        downloaded: completedBytes(runner.files, index),
        progress: total ? completedBytes(runner.files, index) / total : 0,
      })
      const path = await downloadHuggingFaceFile({
        taskId: nativeTaskId,
        repo: runner.repo,
        filename: file.name,
        expectedSize: file.size,
        expectedSha256: file.sha256,
        token: runner.token,
      })
      paths[index] = path
      const downloaded = completedBytes(runner.files, index + 1)
      store.patch(id, {
        paths: [...paths],
        downloaded,
        progress: total ? downloaded / total : (index + 1) / runner.files.length,
      })
    }

    store.patch(id, {
      status: 'verifying',
      currentTaskId: undefined,
      downloaded: total ?? completedBytes(runner.files, runner.files.length),
      progress: 1,
    })
    if (runner.onComplete) {
      store.patch(id, { status: 'importing' })
      await runner.onComplete(paths)
    }
    store.patch(id, { status: 'complete', currentTaskId: undefined, progress: 1 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (pauseIntent.has(id) || /paused|cancelled/i.test(message)) {
      store.patch(id, {
        status: cancelIntent.has(id) ? 'cancelled' : 'paused',
        currentTaskId: undefined,
        error: undefined,
      })
    } else {
      store.patch(id, { status: 'error', currentTaskId: undefined, error: message })
    }
  } finally {
    pauseIntent.delete(id)
    cancelIntent.delete(id)
    running.delete(id)
  }
}

export function startHuggingFaceBundle(input: BundleRunner): Promise<void> {
  runners.set(input.id, input)
  const current = useHuggingFaceDownloads.getState().tasks[input.id]
  if (current?.status === 'complete') {
    useHuggingFaceDownloads.getState().remove(input.id)
  }
  return runBundle(input.id)
}

export async function pauseHuggingFaceBundle(id: string): Promise<void> {
  const task = useHuggingFaceDownloads.getState().tasks[id]
  if (!task?.currentTaskId) return
  pauseIntent.add(id)
  await cancelHuggingFaceDownload(task.currentTaskId).catch(() => {})
}

export async function cancelHuggingFaceBundle(id: string): Promise<void> {
  const task = useHuggingFaceDownloads.getState().tasks[id]
  if (!task) return
  cancelIntent.add(id)
  pauseIntent.add(id)
  if (task.currentTaskId) {
    await cancelHuggingFaceDownload(task.currentTaskId).catch(() => {})
  } else {
    useHuggingFaceDownloads.getState().patch(id, { status: 'cancelled' })
  }
}

export function resumeHuggingFaceBundle(id: string): Promise<void> {
  return runBundle(id)
}

export function retryHuggingFaceBundle(id: string): Promise<void> {
  return runBundle(id)
}
