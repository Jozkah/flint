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
 * called with, a path in a tool's own result, or a file reference the message
 * renderer already validated — never a path guessed out of prose. A link that
 * opens the wrong file, or opens nothing, is worse than plain text.
 */
export type CodeOpenOptions = {
  /** 1-based line to scroll to. */
  line?: number
  /** Add the tab without switching to it or to the Code rail. */
  background?: boolean
}

export type CodeOpen = (path: string, options?: CodeOpenOptions) => void

export const CodeOpenContext = createContext<CodeOpen | null>(null)

/** The opener for this surface, or null where there is no code panel. */
export const useCodeOpen = (): CodeOpen | null => useContext(CodeOpenContext)

/** Whether a path can be opened here, and if not, the sentence saying why. */
export type CodePathCheck = { ok: true } | { ok: false; reason: string }

/** What a surface offers beside opening: a reason check and the diff view. */
export type CodeOpenTools = {
  check?: (path: string) => CodePathCheck
  /**
   * Does the file exist? Asked on a click, never while rendering. Only a
   * definite `false` stops the open; a surface that cannot tell says true.
   */
  exists?: (path: string) => Promise<boolean>
  /** Show this file in Changes. */
  openDiff?: (path: string) => void
  /**
   * The short form a path is shown as: relative to the session sandbox or
   * an attached folder, else the file name. The full path stays in the
   * tooltip and is what a copy of the label puts on the clipboard.
   */
  displayPath?: (path: string) => string
}

/**
 * The folders a surface holds (Cowork: sandbox, project, attached folders;
 * Chat: the thread's attached folders). An absolute path in a reply becomes a
 * link only when it sits inside one of these.
 */
export const PathRootsContext = createContext<readonly string[]>([])

export const usePathRoots = (): readonly string[] => useContext(PathRootsContext)

export const CodeOpenToolsContext = createContext<CodeOpenTools>({})

export const useCodeOpenTools = (): CodeOpenTools =>
  useContext(CodeOpenToolsContext)

/**
 * Tools whose `target` is a path the code panel could show.
 *
 * `find` and `grep` are excluded on purpose: their target is a *pattern*, and
 * the directory is only context. The memory and skill tools address a store
 * by name, not the project. `ls` names a directory, which has no tab to open.
 */
const PATH_TOOLS = new Set(['read', 'write', 'edit'])

export const toolTargetIsPath = (tool: string): boolean => PATH_TOOLS.has(tool)

/** Tools whose result changed a file, so the change has a diff to show. */
export const toolChangesFile = (tool: string): boolean =>
  tool === 'write' || tool === 'edit'

/**
 * Ctrl/Cmd+click and middle-click open in the background, as a browser opens
 * a link in a new tab without leaving the page.
 */
export function openInBackground(e: {
  ctrlKey?: boolean
  metaKey?: boolean
  button?: number
}): boolean {
  return !!(e.ctrlKey || e.metaKey || e.button === 1)
}

/**
 * The line a tool call was aimed at, from its structured arguments: `read`'s
 * `offset` (1-based in the tool's own contract), or an explicit `line` /
 * `start_line`. Undefined when the call names none.
 */
export function lineOfToolInput(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined
  const args = input as Record<string, unknown>
  for (const key of ['line', 'start_line', 'startLine', 'offset']) {
    const raw = args[key]
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value
    }
  }
  return undefined
}

const isAbsolute = (path: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(path)

/**
 * A path a tool printed, made openable: relative entries of a listing are
 * relative to the directory that was listed or searched, absolute ones stand
 * on their own.
 */
export function joinToolPath(base: string | undefined, path: string): string {
  const clean = path.trim()
  if (!base || isAbsolute(clean)) return clean
  const root = base.trim().replace(/[\\/]+$/, '')
  if (!root || root === '.') return clean
  return `${root}/${clean.replace(/^\.\//, '')}`
}
