/**
 * Browser Dialog Service - the file picker is the page's own, and what it
 * picks is uploaded to the Flint server, so callers get server paths just as
 * they get local paths on desktop.
 */

import { toast } from 'sonner'
import { uploadFile } from '@/services/uploads/browser'
import { DefaultDialogService } from './default'
import type { DialogOpenOptions } from './types'

function pickFiles(options?: DialogOpenOptions): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = !!options?.multiple
    const extensions = options?.filters?.flatMap((filter) => filter.extensions) ?? []
    if (extensions.length) input.accept = extensions.map((ext) => `.${ext}`).join(',')
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

export class BrowserDialogService extends DefaultDialogService {
  async open(options?: DialogOpenOptions): Promise<string | string[] | null> {
    // A browser cannot hand the server one of its folders.
    if (options?.directory) return null
    const files = await pickFiles(options)
    if (files.length === 0) return null
    const paths: string[] = []
    for (const file of files) {
      try {
        paths.push((await uploadFile(file)).path)
      } catch (error) {
        toast.error(`Could not upload ${file.name}`, {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (paths.length === 0) return null
    return options?.multiple ? paths : paths[0]
  }
}
