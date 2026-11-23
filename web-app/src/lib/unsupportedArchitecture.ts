// Whether the bundled llama.cpp can load a Hugging Face GGUF at all, asked of
// its header before the multi-GB files are pulled. Only a positive answer
// counts: an architecture that is known and absent from the engine. A header
// that cannot be read (gated repository, offline, odd server) says nothing, so
// the download goes ahead as it always did.

import { readGgufMetadata } from '@janhq/tauri-plugin-llamacpp-api'
import { toast } from 'sonner'
import { i18n } from '@/i18n/react-i18next-compat'
import {
  LLAMA_CPP_ARCHITECTURES,
  LLAMA_CPP_ARCHITECTURES_TAG,
} from '@/lib/llamaArchitectures.generated'

export function isArchitectureSupported(architecture: string): boolean {
  return LLAMA_CPP_ARCHITECTURES.includes(architecture.trim().toLowerCase())
}

export function huggingFaceFileUrl(
  repo: string,
  revision: string | null | undefined,
  filename: string
): string {
  const path = filename.split('/').map(encodeURIComponent).join('/')
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision || 'main')}/${path}`
}

type ReadHeader = (url: string) => Promise<{ metadata?: Record<string, string> }>

/**
 * The architecture named by the model file's header when the bundled engine
 * does not list it, else null. Reads only the start of the file.
 */
export async function findUnsupportedArchitecture(input: {
  repo: string
  revision?: string | null
  filename: string
  read?: ReadHeader
}): Promise<string | null> {
  const read = input.read ?? (readGgufMetadata as ReadHeader)
  try {
    const meta = await read(huggingFaceFileUrl(input.repo, input.revision, input.filename))
    const architecture = meta?.metadata?.['general.architecture']
    if (typeof architecture !== 'string' || !architecture.trim()) return null
    return isArchitectureSupported(architecture) ? null : architecture.trim()
  } catch {
    return null
  }
}

/** Asks whether to download a model the engine cannot load. Dismissing says no. */
export function confirmUnsupportedArchitecture(architecture: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t = i18n.t.bind(i18n)
    toast.warning(t('model-errors:unsupportedArchTitle'), {
      description: t('model-errors:unsupportedArchDescription', {
        architecture,
        tag: LLAMA_CPP_ARCHITECTURES_TAG,
      }),
      duration: Infinity,
      action: { label: t('model-errors:unsupportedArchDownload'), onClick: () => resolve(true) },
      cancel: { label: t('model-errors:unsupportedArchCancel'), onClick: () => resolve(false) },
      onDismiss: () => resolve(false),
    })
  })
}
