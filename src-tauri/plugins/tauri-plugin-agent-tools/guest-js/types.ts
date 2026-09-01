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

/** One project file read for display in the code viewer. */
export interface ProjectFile {
  relPath: string
  size: number
  /** Verbatim UTF-8 text. Empty when `oversized` or `binary`. */
  content: string
  oversized: boolean
  binary: boolean
}

/** One fragment of a tool's live output. */
export type ToolOutputChunk = {
  /** Monotonic per call, so a receiver can assert ordering. */
  seq: number
  /** The tool call this belongs to; a backgrounded `bash` needs it. */
  callId: string | null
  text: string
}
