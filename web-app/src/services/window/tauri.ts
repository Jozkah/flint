/**
 * Tauri Window Service - Desktop implementation
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { WindowConfig, WebviewWindowInstance } from './types'
import { DefaultWindowService } from './default'
import { listen } from '@tauri-apps/api/event'

/**
 * The theme listener of each open labeled window. listen() returns an
 * UnlistenFn that used to be discarded, so every (re)opened window added a
 * global theme-changed listener that outlived it (#92). Keyed by label: a
 * window reopened under the same label replaces, and removes, the old one.
 */
const themeListeners = new Map<string, () => void>()

function dropThemeListener(label: string, unlisten?: () => void) {
  const current = themeListeners.get(label)
  if (!current || (unlisten && current !== unlisten)) return
  themeListeners.delete(label)
  try {
    current()
  } catch (err) {
    console.error('Failed to remove theme listener:', err)
  }
}

export class TauriWindowService extends DefaultWindowService {
  async createWebviewWindow(
    config: WindowConfig
  ): Promise<WebviewWindowInstance> {
    try {
      // Get current theme from localStorage
      const storedTheme = localStorage.getItem('jan-theme')
      let theme: 'light' | 'dark' | undefined = undefined

      if (storedTheme) {
        try {
          const themeData = JSON.parse(storedTheme)
          const activeTheme = themeData?.state?.activeTheme
          const isDark = themeData?.state?.isDark

          // Set theme based on stored preference
          if (activeTheme === 'auto') {
            theme = undefined // Let OS decide
          } else if (
            activeTheme === 'dark' ||
            (activeTheme === 'auto' && isDark)
          ) {
            theme = 'dark'
          } else if (
            activeTheme === 'light' ||
            (activeTheme === 'auto' && !isDark)
          ) {
            theme = 'light'
          }
        } catch (e) {
          console.warn('Failed to parse theme from localStorage:', e)
        }
      }

      const webviewWindow = new WebviewWindow(config.label, {
        url: config.url,
        title: config.title,
        width: config.width,
        height: config.height,
        center: config.center,
        resizable: config.resizable,
        minimizable: config.minimizable,
        maximizable: config.maximizable,
        closable: config.closable,
        fullscreen: config.fullscreen,
        theme: theme,
        incognito: config.incognito,
      })

      // Setup theme listener for this window
      this.setupThemeListenerForWindow(config.label, webviewWindow)

      return this.toWindowInstance(config.label, webviewWindow)
    } catch (error) {
      console.error('Error creating Tauri window:', error)
      throw error
    }
  }

  async getWebviewWindowByLabel(
    label: string
  ): Promise<WebviewWindowInstance | null> {
    try {
      const existingWindow = await WebviewWindow.getByLabel(label)

      if (existingWindow) {
        return this.toWindowInstance(label, existingWindow)
      }

      return null
    } catch (error) {
      console.error('Error getting Tauri window by label:', error)
      return null
    }
  }

  async openWindow(config: WindowConfig): Promise<void> {
    // Check if window already exists first
    const existing = await this.getWebviewWindowByLabel(config.label)
    if (existing) {
      await existing.show()
      await existing.focus()
    } else {
      await this.createWebviewWindow(config)
    }
  }

  async openLogsWindow(): Promise<void> {
    try {
      await this.openWindow({
        url: '/logs',
        label: 'logs-app-window',
        title: 'App Logs - Flint',
        width: 800,
        height: 600,
        resizable: true,
        center: true,
      })
    } catch (error) {
      console.error('Error opening logs window in Tauri:', error)
      throw error
    }
  }

  async openSystemMonitorWindow(): Promise<void> {
    try {
      await this.openWindow({
        url: '/system-monitor',
        label: 'system-monitor-window',
        title: 'System Monitor - Flint',
        width: 1000,
        height: 700,
        resizable: true,
        center: true,
      })
    } catch (error) {
      console.error('Error opening system monitor window in Tauri:', error)
      throw error
    }
  }

  async openLocalApiServerLogsWindow(): Promise<void> {
    try {
      await this.openWindow({
        url: '/local-api-server/logs',
        label: 'logs-window-local-api-server',
        title: 'Local API Server Logs - Flint',
        width: 800,
        height: 600,
        resizable: true,
        center: true,
      })
    } catch (error) {
      console.error(
        'Error opening local API server logs window in Tauri:',
        error
      )
      throw error
    }
  }

  private toWindowInstance(
    label: string,
    webviewWindow: WebviewWindow
  ): WebviewWindowInstance {
    return {
      label,
      async close() {
        dropThemeListener(label)
        await webviewWindow.close()
      },
      async show() {
        await webviewWindow.show()
      },
      async hide() {
        await webviewWindow.hide()
      },
      async focus() {
        await webviewWindow.setFocus()
      },
      async setTitle(title: string) {
        await webviewWindow.setTitle(title)
      },
    }
  }

  private setupThemeListenerForWindow(label: string, window: WebviewWindow): void {
    // Listen to theme change events from Tauri backend
    Promise.resolve({ listen })
      .then(async ({ listen }) => {
        const unlisten = await listen<string>('theme-changed', async (event) => {
          const theme = event.payload
          try {
            if (theme === 'dark') {
              await window.setTheme('dark')
            } else if (theme === 'light') {
              await window.setTheme('light')
            } else {
              await window.setTheme(null)
            }
          } catch (err) {
            console.error('Failed to update window theme:', err)
          }
        })
        dropThemeListener(label)
        themeListeners.set(label, unlisten)
        // A window closed from its own chrome never goes through close().
        if (typeof window.once === 'function') {
          await window.once('tauri://destroyed', () =>
            dropThemeListener(label, unlisten)
          )
        }
      })
      .catch((err) => {
        console.error('Failed to setup theme listener for window:', err)
      })
  }
}

export const __testing = { themeListeners }
