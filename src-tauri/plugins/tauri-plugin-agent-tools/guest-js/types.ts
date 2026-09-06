/** A skill's summary as returned by `skillList`. */
export interface SkillMeta {
  name: string
  description: string
}

/** Outcome of a built-in tool execution. */
export interface ToolResult {
  content: string
  /** Display-only diff for write/edit; never part of model context. */
  diff: string | null
  isError: boolean
}

/**
 * An OpenAI-shaped function schema for a built-in tool, as produced by the
 * plugin's `schema.rs` (the single source of truth).
 */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Which sandbox namespace an id belongs to. */
export type WorkspaceScope = 'thread' | 'session'

/** One entry of a project directory listing (Cowork code panel). */
export interface ProjectEntry {
  name: string
  /** Path relative to the project root, `/`-separated. */
  relPath: string
  isDir: boolean
}

/** One lazily-loaded directory level of an attached project. */
export interface ProjectListing {
  entries: ProjectEntry[]
  /** True when the directory held more entries than the backend cap. */
  truncated: boolean
}

/** One line of a repository map. */
export interface ProjectMapEntry {
  /** Path relative to the project root, `/`-separated. */
  relPath: string
  isDir: boolean
  /** How many path segments deep, with a root entry at 1. */
  depth: number
}

/**
 * A whole attached project's shape, walked once under explicit caps.
 *
 * The fields describing what is *missing* travel with the entries because this
 * map is put in front of a model: one that stops at a cap without saying so
 * invites the conclusion that a file does not exist.
 */
export interface ProjectMap {
  /** Breadth-first; within a level, directories before files by name. */
  entries: ProjectMapEntry[]
  /** The entry budget ran out before the walk finished. */
  truncated: boolean
  /** At least one directory was left undescended at the depth limit. */
  depthLimited: boolean
  /** Files skipped because their names look like credentials. Counted, never
   * named: the path itself is a pointer, and this map becomes prompt text. */
  sensitiveOmitted: number
  /** Directories whose contents could not be read at all. */
  unreadableDirs: number
  files: number
  dirs: number
}

/** One project file read for display in the code viewer. */
export interface ProjectFile {
  relPath: string
  size: number
  /** Verbatim UTF-8 text. Empty when `oversized` or `binary`. */
  content: string
  oversized: boolean
  binary: boolean
}

/** A shell command still running in the background, as reported by
 * `bashJobsList`. Listing never consumes a job's output. */
export interface BashJobStatus {
  jobId: string
  command: string
  elapsedMs: number
  /** The command has produced its output; the agent has not collected it yet. */
  finished: boolean
  /** The tool call that backgrounded it, when known. */
  callId: string | null
}

/** One fragment of a tool's live output. */
export type ToolOutputChunk = {
  /** Monotonic per call, so a receiver can assert ordering. */
  seq: number
  /** The tool call this belongs to; a backgrounded `bash` needs it. */
  callId: string | null
  text: string
}
