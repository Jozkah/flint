import { create } from 'zustand'
import type { Attachment } from '@/types/attachment'

export type ProjectUploadProgress = {
  current: number
  total: number
  currentFileName?: string
}

type IngestFn = (
  projectId: string,
  attachment: Attachment,
) => Promise<{ id?: string }>

type IngestHandlers = {
  onSuccess: () => void
  onError: (error: unknown, fileName?: string) => void
}

/** A file that did not make it into the project, kept until dismissed or retried. */
export type ProjectUploadFailure = {
  fileName: string
  error: unknown
}

interface ProjectUploadsState {
  progress: Record<string, ProjectUploadProgress>
  // Files whose ingestion failed. A toast alone goes unseen (T7-054: a file
  // added with no embedding model left no row and no visible message), so the
  // file list keeps a row with the reason until it is dismissed or retried.
  failures: Record<string, ProjectUploadFailure[]>
  dismissFailure: (projectId: string, fileName: string) => void
  // Monotonic counter per project that increments after every successful
  // ingestion. Consumers watch this to refresh their file list whenever a
  // file finishes in the background — including while they were unmounted.
  completedTick: Record<string, number>
  isIngesting: (projectId: string) => boolean
  ingest: (
    projectId: string,
    attachments: Attachment[],
    ingestFn: IngestFn,
    handlers: IngestHandlers,
  ) => Promise<void>
}

export const useProjectUploads = create<ProjectUploadsState>((set, get) => ({
  progress: {},
  completedTick: {},
  failures: {},
  dismissFailure: (projectId, fileName) =>
    set((s) => ({
      failures: {
        ...s.failures,
        [projectId]: (s.failures[projectId] ?? []).filter(
          (f) => f.fileName !== fileName
        ),
      },
    })),
  isIngesting: (projectId) => !!get().progress[projectId],
  ingest: async (projectId, attachments, ingestFn, handlers) => {
    const total = attachments.length
    if (total === 0) return
    if (get().progress[projectId]) return

    // Retrying a file replaces its old failure row.
    const retried = new Set(attachments.map((a) => a.name))
    set((s) => ({
      failures: {
        ...s.failures,
        [projectId]: (s.failures[projectId] ?? []).filter(
          (f) => !retried.has(f.fileName)
        ),
      },
    }))

    set((s) => ({
      progress: {
        ...s.progress,
        [projectId]: {
          current: 0,
          total,
          currentFileName: attachments[0]?.name,
        },
      },
    }))

    let firstError: unknown
    let firstFailedName: string | undefined
    let failedCount = 0
    try {
      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i]

        set((s) => {
          const existing = s.progress[projectId]
          if (!existing) return s
          return {
            progress: {
              ...s.progress,
              [projectId]: {
                ...existing,
                current: i,
                currentFileName: att.name,
              },
            },
          }
        })

        // One bad file must not stop the files after it.
        let failure: unknown
        let failed = false
        try {
          const result = await ingestFn(projectId, att)
          if (!result.id) throw new Error('Failed to ingest file')
        } catch (error) {
          failed = true
          failure = error
        }

        if (failed) {
          failedCount++
          if (failedCount === 1) {
            firstError = failure
            firstFailedName = att.name
          }
          const fileName = att.name
          set((s) => ({
            failures: {
              ...s.failures,
              [projectId]: [
                ...(s.failures[projectId] ?? []).filter(
                  (f) => f.fileName !== fileName
                ),
                { fileName, error: failure },
              ],
            },
          }))
        }

        set((s) => {
          const existing = s.progress[projectId]
          const nextTick = (s.completedTick[projectId] ?? 0) + (failed ? 0 : 1)
          return {
            progress: existing
              ? {
                  ...s.progress,
                  [projectId]: { ...existing, current: i + 1 },
                }
              : s.progress,
            completedTick: { ...s.completedTick, [projectId]: nextTick },
          }
        })
      }
      if (failedCount === 0) handlers.onSuccess()
      else handlers.onError(firstError, firstFailedName)
    } finally {
      set((s) => {
        const next = { ...s.progress }
        delete next[projectId]
        return { progress: next }
      })
    }
  },
}))
