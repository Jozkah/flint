/**
 * Browser Assistants Service - reads and writes the server's assistants
 * folder, the same records the desktop assistant extension uses.
 */

import type { Assistant } from '@janhq/core'
import { browserApi, jsonRequest } from '@/services/browserApi'
import type { AssistantsService } from './types'

export class BrowserAssistantsService implements AssistantsService {
  getAssistants(): Promise<Assistant[] | null> {
    return browserApi<Assistant[]>('/api/v1/assistants')
  }

  async createAssistant(assistant: Assistant): Promise<void> {
    await browserApi<void>('/api/v1/assistants', jsonRequest('POST', assistant))
  }

  async deleteAssistant(assistant: Assistant): Promise<void> {
    await browserApi<void>(`/api/v1/assistants/${encodeURIComponent(assistant.id)}`, {
      method: 'DELETE',
    })
  }
}
