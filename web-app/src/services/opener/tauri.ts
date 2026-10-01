/**
 * Tauri Opener Service - Desktop implementation
 */

import { invoke } from '@tauri-apps/api/core'
import { openUrl as osOpenUrl } from '@tauri-apps/plugin-opener'
import { DefaultOpenerService } from './default'

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
      await invoke('open_session_path', { roots: [...roots], path, mode })
    } catch (error) {
      console.error(`Error trying to ${mode} a path in Tauri:`, error)
      throw error
    }
  }

  async openUrl(url: string): Promise<void> {
    try {
      await osOpenUrl(url)
    } catch (error) {
      console.error('Error opening url in Tauri:', error)
      throw error
    }
  }
}
