import { invalidate } from './rpc'

/** Refresh everything the archive can change. */
export const archiveChanged = () => invalidate(['archive.', 'sessions.list', 'rooms.', 'library.list'])
