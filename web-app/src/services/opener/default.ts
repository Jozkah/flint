/**
 * Default Opener Service - Generic implementation with minimal returns
 */

import type { OpenerService } from './types'

export class DefaultOpenerService implements OpenerService {
  async revealItemInDir(path: string): Promise<void> {
    console.log('revealItemInDir called with path:', path)
    // No-op - not implemented in default service
  }

  async openPath(path: string): Promise<void> {
    console.log('openPath called with path:', path)
    // No-op - not implemented in default service
  }

  async openUrl(url: string): Promise<void> {
    console.log('openUrl called with url:', url)
    // No-op - not implemented in default service
  }
}
