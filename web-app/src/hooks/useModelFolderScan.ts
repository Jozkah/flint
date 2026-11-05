import { useState } from 'react'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelLibrary } from '@/hooks/useModelLibrary'
import {
  modelsOutsideFolder,
  scanLocalModels,
  type ScannedModel,
} from '@/lib/localModelScan'
import { normalizeAppError } from '@/utils/appError'

type ScanState =
  | { status: 'idle' }
  | { status: 'scanning' }
  | { status: 'done'; models: ScannedModel[] }
  | { status: 'failed'; message: string }

/** The model-library folder list and the scan of those folders, as the
 * GGUF import dialog shows them. */
export function useModelFolderScan() {
  const serviceHub = useServiceHub()
  const [scanState, setScanState] = useState<ScanState>({ status: 'idle' })

  const modelFolders = useModelLibrary((s) => s.folders)
  const addModelFolder = useModelLibrary((s) => s.addFolder)
  const removeFolder = useModelLibrary((s) => s.removeFolder)

  const runScan = async (folders: string[] = modelFolders) => {
    setScanState({ status: 'scanning' })
    try {
      setScanState({ status: 'done', models: await scanLocalModels(folders) })
    } catch (error) {
      setScanState({ status: 'failed', message: normalizeAppError(error) })
    }
  }

  const handleAddFolder = async () => {
    const picked = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })
    if (picked && typeof picked === 'string') {
      addModelFolder(picked)
      await runScan([...new Set([...modelFolders, picked])])
    }
  }

  const removeModelFolder = (folder: string) => {
    removeFolder(folder)
    setScanState((s) =>
      s.status === 'done'
        ? {
            status: 'done',
            models: modelsOutsideFolder(s.models, folder),
          }
        : s
    )
  }

  return {
    scanState,
    runScan,
    handleAddFolder,
    removeModelFolder,
    modelFolders,
  }
}
