// Hugging Face downloads that a quit, crash or pause left unfinished, kept so
// they come back after a relaunch as paused rows instead of vanishing.
//
// The download store lives in memory, and each download finishes through a
// closure (installing the GGUF, importing the MLX folder) that cannot be
// saved. So each download that can come back carries a `finish` description in
// plain data, and the finish step is rebuilt from it on restore. The partial
// files stay on disk under their `.part` names, and the downloader resumes
// them with a Range request; files already finished are skipped by index.
//
// No token is stored: a resumed download reads the one in Settings.

import type { HuggingFaceFile, HuggingFaceFileGroup } from '@/lib/huggingface'

const STORAGE_KEY = 'flint-interrupted-downloads'

/** How a download is installed once its files are on disk. */
export type DownloadFinish =
  | {
      kind: 'gguf'
      modelId: string
      repo: string
      revision?: string | null
      group: HuggingFaceFileGroup
      mmproj?: HuggingFaceFileGroup | null
      draft?: HuggingFaceFileGroup | null
      /** An update: the installed copy is removed before the new one goes in. */
      replace?: boolean
    }
  | {
      kind: 'mlx'
      modelId: string
      repo: string
      revision?: string | null
      replace?: boolean
    }
  | { kind: 'voice' }

export type InterruptedDownload = {
  id: string
  repo: string
  label: string
  files: HuggingFaceFile[]
  revision?: string | null
  /** Paths of the files already finished, by index. */
  paths: string[]
  downloaded: number
  total?: number
  finish: DownloadFinish
}

function isRecord(value: unknown): value is InterruptedDownload {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<InterruptedDownload>
  return (
    typeof v.id === 'string' &&
    typeof v.repo === 'string' &&
    typeof v.label === 'string' &&
    Array.isArray(v.files) &&
    Array.isArray(v.paths) &&
    !!v.finish &&
    typeof v.finish === 'object' &&
    ['gguf', 'mlx', 'voice'].includes((v.finish as DownloadFinish).kind)
  )
}

/** The saved downloads; an unreadable or blocked store reads as none. */
export function readInterruptedDownloads(): InterruptedDownload[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

let lastWritten: string | null = null

/** Save `records`, skipping the write when nothing changed. */
export function writeInterruptedDownloads(records: InterruptedDownload[]): void {
  const serialized = JSON.stringify(records)
  if (serialized === lastWritten) return
  try {
    if (records.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, serialized)
    lastWritten = serialized
  } catch {
    // Storage full or blocked: the download still runs, it just will not
    // come back after a relaunch.
  }
}

/** Test seam: forget what was last written. */
export function resetInterruptedDownloadsCache(): void {
  lastWritten = null
}
