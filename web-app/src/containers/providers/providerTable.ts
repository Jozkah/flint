/** Remote lists longer than a filter threshold render this many rows at a time. */
export const MODEL_PAGE_SIZE = 12

/** Models table columns: mark, name, capabilities, (size, context,) status, actions. */
export const LOCAL_COLS =
  '30px minmax(110px,1fr) 64px 72px 80px 156px 252px'
export const REMOTE_COLS = '30px minmax(140px,1fr) 72px 130px auto'

/** What the file list on disk says about one installed model. */
export type LocalFileInfo = { sizeBytes?: number; fileName?: string; path?: string }
