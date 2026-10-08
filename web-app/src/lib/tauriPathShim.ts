/**
 * Stand-in for `@tauri-apps/api/path` in the browser build: the few pure
 * string helpers the extensions use. Anything that needs the host's folders is
 * answered by the server instead.
 */

const separator = /[\\/]+/

export async function basename(path: string, ext?: string): Promise<string> {
  const parts = path.split(separator).filter(Boolean)
  const name = parts.length ? parts[parts.length - 1] : ''
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name
}

export async function dirname(path: string): Promise<string> {
  const parts = path.split(separator)
  parts.pop()
  return parts.join('/') || '/'
}

export async function extname(path: string): Promise<string> {
  const name = await basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export async function join(...paths: string[]): Promise<string> {
  return paths.filter(Boolean).join('/').replace(/\/{2,}/g, '/')
}

/** The server's separator is not knowable here; paths it returns use `/` or `\`. */
export function sep(): string {
  return '/'
}
