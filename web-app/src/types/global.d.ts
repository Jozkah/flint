export {}

declare module 'react-syntax-highlighter-virtualized-renderer'

type AppCore = {
  api: APIs
  extensionManager: ExtensionManager | undefined
}

declare global {
  declare const IS_TAURI: boolean
  declare const IS_WEB_APP: boolean
  declare const IS_MACOS: boolean
  declare const IS_WINDOWS: boolean
  declare const IS_LINUX: boolean
  declare const IS_IOS: boolean
  declare const IS_ANDROID: boolean
  declare const PLATFORM: string
  declare const VERSION: string
  /** The commit this build was made from, or an empty string for a local build. */
  declare const BUILD_COMMIT: string
  declare const IS_DEV: boolean
  interface Window {
    core: AppCore | undefined
  }
}
