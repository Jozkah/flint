/**
 * Folders attached to a chat. Stored on the thread's metadata and handed to
 * Chat's agent tools the way Cowork hands over its folders: the first as the
 * read-only project, the rest as extra projects. Read-only: a chat has no
 * write grant, so its tools can read and search these folders but every
 * write still lands in the chat's own sandbox.
 */
import { useThreads } from '@/hooks/useThreads'
import { canonicalKey } from '@/lib/groups/domain'
import type { FolderAdapter } from '@/lib/groups/inherit'

/** The folders attached to a chat, in the order they were added. */
export function chatFoldersOf(thread: Thread | undefined): string[] {
  const raw = thread?.metadata?.folders
  return Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
}

/** Replace a chat's folders; duplicates (by canonical path) are dropped. */
export function setChatFolders(threadId: string, folders: string[]) {
  const thread = useThreads.getState().threads[threadId]
  if (!thread) return
  const seen = new Set<string>()
  const next = folders.filter((f) => {
    const key = canonicalKey(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  useThreads.getState().updateThread(threadId, {
    metadata: { ...thread.metadata, folders: next },
  })
}

/** The agent-tool options that give a chat's tools its folders. */
export function chatFolderToolOptions(threadId: string): {
  readOnlyProject?: string
  extraProjects?: string[]
} {
  const folders = chatFoldersOf(useThreads.getState().threads[threadId])
  if (folders.length === 0) return {}
  return { readOnlyProject: folders[0], extraProjects: folders.slice(1) }
}

export const chatFolderAdapter: FolderAdapter = {
  attached: async (id) => chatFoldersOf(useThreads.getState().threads[id]),
  attach: async (id, paths) => {
    const thread = useThreads.getState().threads[id]
    if (!thread || paths.length === 0) return []
    setChatFolders(id, [...chatFoldersOf(thread), ...paths])
    return paths
  },
  detach: async (id, paths) => {
    const thread = useThreads.getState().threads[id]
    if (!thread) return
    const drop = new Set(paths.map(canonicalKey))
    setChatFolders(
      id,
      chatFoldersOf(thread).filter((f) => !drop.has(canonicalKey(f)))
    )
  },
}
