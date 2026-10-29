/**
 * Tauri Opener Service - Desktop implementation
 */

import { openUrl as osOpenUrl } from '@tauri-apps/plugin-opener'
import { invokeCommand } from '@/lib/backend'
import { DefaultOpenerService } from './default'
import { isExternalUrl } from './externalUrl'

export class TauriOpenerService extends DefaultOpenerService {
  /**
   * Files and folders go through the `open_session_path` command, never the
   * opener plugin: the backend canonicalizes the path, allows only the app's
   * own data folder plus the caller's `roots` (the user's attached folders),
   * and refuses to open executables. The plugin's file permissions are not
   * granted to the webview at all.
   */
  async revealItemInDir(path: string, roots: readonly string[] = []): Promise<void> {
    await this.viaBackend(path, roots, 'reveal')
  }

  async openPath(path: string, roots: readonly string[] = []): Promise<void> {
    await this.viaBackend(path, roots, 'open')
  }

  private async viaBackend(
    path: string,
    roots: readonly string[],
    mode: 'open' | 'reveal'
  ): Promise<void> {
    try {
      await invokeCommand('open_session_path', { roots: [...roots], path, mode })
    } catch (error) {
      console.error(`Error trying to ${mode} a path in Tauri:`, error)
      throw error
    }
  }

  async openUrl(url: string): Promise<void> {
    // Only web and mail links leave the app. A file:, javascript: or custom
    // protocol url (from a model, a link or an MCP server) is refused here so
    // no caller can hand the OS an arbitrary handler.
    if (!isExternalUrl(url)) {
      throw new Error(`Refusing to open a non-http(s)/mailto url: ${url.slice(0, 80)}`)
    }
    try {
      await osOpenUrl(url)
    } catch (error) {
      console.error('Error opening url in Tauri:', error)
      throw error
    }
  }
}
