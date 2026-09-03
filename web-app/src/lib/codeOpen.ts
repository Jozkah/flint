import { createContext, useContext } from 'react'

/**
 * Opens a file path in the Cowork code panel, when a surface offers that.
 *
 * A context rather than a prop because the tool widgets sit three components
 * below the transcript and are shared with chat, which has no code panel.
 * Chat provides nothing, so `useCodeOpen()` is null there and the widgets
 * stay inert — the affordance exists exactly where it can work.
 *
 * Only *structured* paths are ever passed in: the `path` argument a tool was
 * called with, never a path parsed out of prose. Free text is not a reliable
 * source of file references, and a link that opens the wrong file — or opens
 * nothing — is worse than plain text.
 */
export type CodeOpen = (path: string) => void

export const CodeOpenContext = createContext<CodeOpen | null>(null)

/** The opener for this surface, or null where there is no code panel. */
export const useCodeOpen = (): CodeOpen | null => useContext(CodeOpenContext)

/**
 * Tools whose `target` is a path the code panel could show.
 *
 * `find` and `grep` are excluded on purpose: their target is a *pattern*, and
 * the directory is only context. The memory and skill tools address a store
 * by name, not the project. `ls` names a directory, which has no tab to open.
 */
const PATH_TOOLS = new Set(['read', 'write', 'edit'])

export const toolTargetIsPath = (tool: string): boolean => PATH_TOOLS.has(tool)
