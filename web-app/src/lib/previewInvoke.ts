import { invoke as tauriInvoke, type InvokeArgs } from '@tauri-apps/api/core'

/**
 * Development-only answers for Tauri commands, so pages backed by commands
 * (plugins, skills) can be looked at in a plain browser with `?preview`
 * (see dev/previewSeed.ts). The preview seed installs a handler on `window`;
 * a handler returning `undefined` passes the command through.
 *
 * `import.meta.env.DEV` is false in production builds, so the whole branch is
 * dropped there and every call goes straight to Tauri.
 */
type PreviewHandler = (
  command: string,
  args?: InvokeArgs
) => Promise<unknown> | undefined

export function previewCall<T>(
  command: string,
  args?: InvokeArgs
): Promise<T> | undefined {
  if (!import.meta.env.DEV || typeof window === 'undefined') return undefined
  const handler = (window as unknown as { __FLINT_PREVIEW_INVOKE__?: PreviewHandler })
    .__FLINT_PREVIEW_INVOKE__
  return handler?.(command, args) as Promise<T> | undefined
}

/** `invoke` from `@tauri-apps/api/core`, answered by the preview seed when one is installed. */
export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  return previewCall<T>(command, args) ?? tauriInvoke<T>(command, args)
}
