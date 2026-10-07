/**
 * Browser Core Service - the app's file and engine calls go to the Flint
 * server, and the one bundled extension that can run in a browser is loaded.
 *
 * Only the llama.cpp extension is loaded: its engine runs in a worker process
 * the server supervises. The other bundled extensions either have a server
 * adapter already (threads, assistants, MCP) or need the desktop (RAG, vector
 * DB), and loading them as well would put two owners on the same data.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ExtensionManifest } from '@/lib/extension'
import type { InvokeArgs } from './types'
import { DefaultCoreService } from './default'
import { getBundledExtensions } from './bundled-extensions'

const BROWSER_EXTENSIONS = ['@janhq/llamacpp-extension']

export class BrowserCoreService extends DefaultCoreService {
  async invoke<T = unknown>(command: string, args?: InvokeArgs): Promise<T> {
    return invoke<T>(command, args)
  }

  async getActiveExtensions(): Promise<ExtensionManifest[]> {
    return getBundledExtensions({ only: BROWSER_EXTENSIONS })
  }

  async installExtension(): Promise<ExtensionManifest[]> {
    return getBundledExtensions({ only: BROWSER_EXTENSIONS })
  }
}
