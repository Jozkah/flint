/**
 * Tauri Dialog Service - Desktop implementation
 */

import type { DialogOpenOptions } from './types'
import { invokeCommand } from '@/lib/backend'
import { DefaultDialogService } from './default'

export class TauriDialogService extends DefaultDialogService {
  async open(options?: DialogOpenOptions): Promise<string | string[] | null> {
    try {
      const result = await invokeCommand<string | string[] | null>('open_dialog', {
        options,
      })
      return result
    } catch (error) {
      console.error('Error opening dialog in Tauri:', error)
      return null
    }
  }

  async save(options?: DialogOpenOptions): Promise<string | null> {
    try {
      return await invokeCommand<string | null>('save_dialog', { options })
    } catch (error) {
      console.error('Error opening save dialog in Tauri:', error)
      return null
    }
  }
}
