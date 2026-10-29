import type { ProjectEntry } from '@janhq/tauri-plugin-agent-tools-api'
import type { BoundedRead } from '@/lib/boundedRead'
import { isNotFoundError } from '@/lib/fileErrors'

/** One explorer folder's listing, as the Code rail holds it. */
export type DirState =
  | { status: 'loading' }
  | { status: 'ready'; entries: ProjectEntry[]; truncated: boolean }
  /** The OS refused: a state of its own, not a failure to report raw. */
  | { status: 'denied' }
  | { status: 'error'; message: string }

/** One open tab's bytes, or why there are none. */
export type FileState =
  | { status: 'loading' }
  /** The project this tab came from is no longer attached. */
  | { status: 'detached' }
  | { status: 'ready'; content: string }
  | { status: 'oversized'; size: number; preview?: string }
  | { status: 'binary' }
  /** Not there (any more). `detail` is the technical message. */
  | { status: 'missing'; detail?: string }
  | { status: 'denied' }
  | { status: 'sensitive' }
  /**
   * An external tab whose handle did not survive. Tab metadata persists;
   * the capability to read the file does not.
   */
  | { status: 'external-gone' }
  | { status: 'error'; message: string }

/** Marker the Rust side puts on an error the OS refused for permissions. */
export const DENIED_PREFIX = 'DENIED: '

/** A failed `projectListDir`, as the folder's state. */
export function dirErrorState(message: string): DirState {
  return message.startsWith(DENIED_PREFIX)
    ? { status: 'denied' }
    : { status: 'error', message }
}

/** A failed `projectReadFile`, as the tab's state. */
export function projectReadErrorState(message: string): FileState {
  return message.startsWith('SENSITIVE:')
    ? { status: 'sensitive' }
    : message.startsWith(DENIED_PREFIX)
      ? { status: 'denied' }
      : isNotFoundError(message)
        ? { status: 'missing', detail: message }
        : { status: 'error', message }
}

/**
 * A sandbox read off disk, as the tab's state. Null for an aborted read: it
 * was replaced or the roots changed, so nothing is recorded.
 */
export function boundedReadState(read: BoundedRead): FileState | null {
  switch (read.status) {
    case 'ready':
      return { status: 'ready', content: read.content }
    case 'oversized':
      return { status: 'oversized', size: read.size, preview: read.preview }
    case 'binary':
      return { status: 'binary' }
    case 'missing':
      return { status: 'missing', detail: '404' }
    default:
      if (read.message === 'aborted') return null
      return isNotFoundError(read.message)
        ? { status: 'missing', detail: read.message }
        : { status: 'error', message: read.message }
  }
}
