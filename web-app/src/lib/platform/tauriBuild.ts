/**
 * Whether this is the desktop (Tauri) build, by the build flag alone. Unlike
 * `isPlatformTauri` it does not look for the runtime bridge. The flag is read
 * at call time so tests can switch it.
 */
export const isTauriBuild = (): boolean =>
  typeof IS_TAURI !== 'undefined' && !!IS_TAURI
