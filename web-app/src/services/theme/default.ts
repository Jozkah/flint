/**
 * Default Theme Service - Generic implementation with minimal returns
 */

import type { ThemeService, ThemeMode } from './types'

// The parameters stay in the signatures: `TauriThemeService` extends this
// class and overrides with the theme argument, which a zero-argument base
// method would not accept. They are deliberately unused -- this service does
// nothing -- and deliberately not logged.
export class DefaultThemeService implements ThemeService {
  async setTheme(theme: ThemeMode): Promise<void> {
    void theme
  }

  getCurrentWindow() {
    return {
      setTheme: (theme: ThemeMode): Promise<void> => {
        void theme
        return Promise.resolve()
      },
    }
  }
}
