import { useState } from 'react'
import { toast } from 'sonner'
import { namedFilePaths } from '@/lib/fileDrop'
import { droppedFilePaths } from '@/lib/documentIngest'

type Options = {
  /** Attachments are on in Settings; off answers every drop with a hint. */
  enabled: boolean
  /** Ingest these paths (files or folders). */
  onPaths: (paths: string[]) => Promise<void>
  t: (key: string, opts?: Record<string, unknown>) => string
}

/**
 * Drag-and-drop onto a project's file list: the drag highlight, and turning a
 * drop into paths to ingest. A drop that only names paths as text is asked
 * about rather than taken.
 */
export function useProjectFileDrop({ enabled, onPaths, t }: Options) {
  const [isDragging, setIsDragging] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (!enabled) {
      toast.info(
        t('common:toast.attachmentsDisabledInfo.title') ??
          'Attachments are disabled in Settings'
      )
      return
    }

    // Tauri provides paths directly on the dropped File objects.
    const paths = droppedFilePaths(e.dataTransfer)

    // WebKitGTK may give no File objects (and Tauri's File has no `path`),
    // but a file-manager drop names its files as URIs. Bare text paths are
    // not taken: dragging `/home/me` out of a terminal is not an upload. A
    // folder named this way is never walked without the user saying so.
    if (paths.length === 0) {
      const found = namedFilePaths(e.dataTransfer)
      const named = found?.paths ?? []
      const { fs } = await import('@janhq/core')
      for (const p of named) {
        const stat = await fs.fileStat(p).catch(() => undefined)
        // Only GNOME's own drag type is trusted to attach by itself: a page
        // can name any path in text a dragged link carries. Everything else is
        // asked about, like a folder.
        if (!stat?.isDirectory && found?.trusted) {
          paths.push(p)
          continue
        }
        const name = p.split(/[\\/]/).filter(Boolean).pop() || p
        toast.info(
          t(stat?.isDirectory ? 'common:pastedPath.folder' : 'common:pastedPath.file', { name }),
          {
            action: {
              label: t('common:pastedPath.attach'),
              onClick: () => void onPaths([p]),
            },
          }
        )
      }
    }

    if (paths.length > 0) {
      await onPaths(paths)
    }
  }

  return { isDragging, handleDragOver, handleDragLeave, handleDrop }
}
