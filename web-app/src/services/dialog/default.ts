/**
 * Default Dialog Service - Generic implementation with minimal returns
 */

import type { DialogService, DialogOpenOptions } from './types'

// The parameters stay in the signatures so `TauriDialogService`, which extends
// this class, overrides methods of the same shape. Deliberately unused, and
// deliberately not logged: dialog options carry paths.
export class DefaultDialogService implements DialogService {
  async open(options?: DialogOpenOptions): Promise<string | string[] | null> {
    void options
    return null
  }

  async save(options?: DialogOpenOptions): Promise<string | null> {
    void options
    return null
  }
}
