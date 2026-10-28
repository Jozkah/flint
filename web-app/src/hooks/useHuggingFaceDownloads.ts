import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import {
  startSpeedSample,
  updateSpeedSample,
  type SpeedSample,
} from '@/lib/downloadSpeed'
import {
  cancelHuggingFaceDownload,
  downloadHuggingFaceFile,
  type HuggingFaceDownloadProgress,
  type HuggingFaceFile,
} from '@/lib/huggingface'
import {
  writeInterruptedDownloads,
  type DownloadFinish,
  type InterruptedDownload,
} from '@/lib/interruptedDownloads'

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
  /** Smoothed download speed in bytes per second, while downloading. */
  bytesPerSecond?: number
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
  remove: (id) => {
    forgetBundle(id)
    set((state) => {
      const tasks = { ...state.tasks }
      delete tasks[id]
      return { tasks }
    })
  },
}))

type BundleRunner = {
  id: string
  repo: string
  label: string
  files: HuggingFaceFile[]
  token?: string
  revision?: string | null
  onComplete?: (paths: string[]) => Promise<void>
  /**
   * How to finish this download in plain data. Only a download that has one
   * is saved and comes back, paused, after a relaunch (see
   * lib/interruptedDownloads).
   */
  finish?: DownloadFinish
}

const runners = new Map<string, BundleRunner>()
const running = new Set<string>()
const pauseIntent = new Set<string>()
const cancelIntent = new Set<string>()
let progressListener: Promise<() => void> | null = null
let persisting = false

/** Thrown inside the download loop when a pause or cancel was asked for. */
class BundleStop extends Error {
  constructor(readonly kind: 'paused' | 'cancelled') {
    super(kind)
  }
}

/**
 * Drop everything kept for a bundle: its runner (and token), speed sample and
 * stop intents. Only for a bundle that cannot be resumed any more; a paused or
 * failed one keeps its runner so resume and retry still work.
 */
function forgetBundle(id: string) {
  runners.delete(id)
  speedSamples.delete(id)
  pauseIntent.delete(id)
  cancelIntent.delete(id)
}

// A download a relaunch can bring back: still to finish, or failed with a retry.
const UNFINISHED: HuggingFaceTaskStatus[] = [
  'queued',
  'downloading',
  'paused',
  'verifying',
  'importing',
  'error',
]

/**
 * Keep the saved list in step with the store. Bytes are counted by finished
 * file, so the list is rewritten when a file or a status changes, not on every
 * progress event.
 */
function persistUnfinished(tasks: Record<string, HuggingFaceDownloadTask>) {
  const records: InterruptedDownload[] = []
  for (const task of Object.values(tasks)) {
    const runner = runners.get(task.id)
    if (!runner?.finish || !UNFINISHED.includes(task.status)) continue
    const paths = task.paths.filter((path): path is string => typeof path === 'string')
    records.push({
      id: task.id,
      repo: runner.repo,
      label: runner.label,
      files: runner.files,
      revision: runner.revision ?? null,
      paths,
      downloaded: completedBytes(runner.files, paths.length),
      total: task.total,
      finish: runner.finish,
    })
  }
  writeInterruptedDownloads(records)
}

function ensurePersistence() {
  if (persisting) return
  persisting = true
  useHuggingFaceDownloads.subscribe((state) => persistUnfinished(state.tasks))
}

function totalBytes(files: HuggingFaceFile[]): number | undefined {
  if (!files.length || files.some((file) => typeof file.size !== 'number')) return undefined
  return files.reduce((sum, file) => sum + (file.size ?? 0), 0)
}

function completedBytes(files: HuggingFaceFile[], count: number): number {
  return files.slice(0, count).reduce((sum, file) => sum + (file.size ?? 0), 0)
}

// Speed is measured here, between progress events, and kept off the store's
// persisted shape: it means nothing once the download is not running.
const speedSamples = new Map<string, SpeedSample>()

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
      const sample = updateSpeedSample(
        speedSamples.get(task.id) ?? startSpeedSample(task.downloaded, Date.now()),
        downloaded,
        Date.now()
      )
      speedSamples.set(task.id, sample)
      store.patch(task.id, {
        downloaded,
        total,
        progress: total && total > 0 ? Math.min(1, downloaded / total) : task.progress,
        bytesPerSecond: sample.bytesPerSecond > 0 ? sample.bytesPerSecond : undefined,
      })
    }
  ).catch((error) => {
    // Do not cache the failure, so the next run tries to listen again.
    console.warn('Could not listen for Hugging Face download progress', error)
    progressListener = null
    return () => {}
  })
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

  const stopIfAsked = () => {
    if (cancelIntent.has(id)) throw new BundleStop('cancelled')
    if (pauseIntent.has(id)) throw new BundleStop('paused')
  }

  try {
    for (let index = startAt; index < runner.files.length; index++) {
      stopIfAsked()
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
        revision: runner.revision ?? undefined,
        bundleRemaining: runner.files
          .slice(index)
          .reduce((sum, item) => sum + (item.size ?? 0), 0),
      })
      paths[index] = path
      const downloaded = completedBytes(runner.files, index + 1)
      store.patch(id, {
        paths: [...paths],
        downloaded,
        progress: total ? downloaded / total : (index + 1) / runner.files.length,
      })
    }

    stopIfAsked()
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
    forgetBundle(id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof BundleStop || pauseIntent.has(id) || /paused|cancelled/i.test(message)) {
      const status =
        error instanceof BundleStop ? error.kind : cancelIntent.has(id) ? 'cancelled' : 'paused'
      store.patch(id, { status, currentTaskId: undefined, error: undefined })
      if (status === 'cancelled') forgetBundle(id)
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
  ensurePersistence()
  const current = useHuggingFaceDownloads.getState().tasks[input.id]
  if (current?.status === 'complete') {
    useHuggingFaceDownloads.getState().remove(input.id)
  }
  // After the remove above: removing a task also forgets its runner.
  runners.set(input.id, input)
  return runBundle(input.id)
}

export async function pauseHuggingFaceBundle(id: string): Promise<void> {
  const task = useHuggingFaceDownloads.getState().tasks[id]
  if (!task) return
  // Nothing to pause when it is not running (a stale intent would pause the
  // next run), and the verify/import step cannot be paused.
  if (!running.has(id) && !task.currentTaskId) return
  if (task.status === 'verifying' || task.status === 'importing') return
  pauseIntent.add(id)
  // Between two files there is no native task; the loop honours the intent
  // at its next iteration.
  if (task.currentTaskId) await cancelHuggingFaceDownload(task.currentTaskId).catch(() => {})
}

export async function cancelHuggingFaceBundle(id: string): Promise<void> {
  const task = useHuggingFaceDownloads.getState().tasks[id]
  if (!task) return
  // The import cannot be undone, so a cancel there is ignored.
  if (task.status === 'verifying' || task.status === 'importing') return
  if (running.has(id)) {
    cancelIntent.add(id)
    pauseIntent.add(id)
    if (task.currentTaskId) await cancelHuggingFaceDownload(task.currentTaskId).catch(() => {})
    return
  }
  useHuggingFaceDownloads.getState().patch(id, {
    status: 'cancelled',
    currentTaskId: undefined,
  })
  forgetBundle(id)
}

/**
 * Bring back a download saved before a relaunch as a paused row. `runner`
 * carries the finish step rebuilt from the saved description. A download
 * already known this session is left alone.
 */
export function restoreHuggingFaceBundle(
  runner: BundleRunner,
  saved: InterruptedDownload
): void {
  ensurePersistence()
  if (runners.has(runner.id) || useHuggingFaceDownloads.getState().tasks[runner.id]) return
  runners.set(runner.id, runner)
  const paths = saved.paths.slice(0, runner.files.length)
  const total = saved.total ?? totalBytes(runner.files)
  const downloaded = completedBytes(runner.files, paths.length)
  useHuggingFaceDownloads.getState().upsert({
    id: runner.id,
    repo: runner.repo,
    label: runner.label,
    status: 'paused',
    files: runner.files,
    paths,
    currentFileIndex: paths.length,
    downloaded,
    total,
    progress: total ? Math.min(1, downloaded / total) : 0,
  })
}

/** Drop a stopped download's row; it stops being saved with it. */
export function dismissHuggingFaceBundle(id: string): void {
  if (running.has(id)) return
  useHuggingFaceDownloads.getState().remove(id)
}

export function resumeHuggingFaceBundle(id: string): Promise<void> {
  return runBundle(id)
}

export function retryHuggingFaceBundle(id: string): Promise<void> {
  return runBundle(id)
}
