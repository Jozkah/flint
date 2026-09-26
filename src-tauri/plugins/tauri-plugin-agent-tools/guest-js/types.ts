/** A skill's summary as returned by `skillList`. */
export interface SkillMeta {
  /** `name` for a store skill, `<plugin>:<skill>` for a plugin skill. */
  name: string
  description: string
  /** The installed plugin this skill ships in; absent for a store skill. */
  plugin?: string
}

/**
 * What a command used, or why it was not measured (AH-174). `measured` false
 * carries `reason` and no figures: an unmeasured command is never zero.
 */
export interface ToolResources {
  measured: boolean
  cpuMs?: number
  peakMemoryBytes?: number
  processes?: number
  reason?: string
}

/** What all of a run's commands used (AH-174). */
export interface RunResources {
  commands: number
  measuredCommands: number
  cpuMs: number
  peakMemoryBytes: number
  processes: number
  unmeasuredReason?: string
}

/** Outcome of a built-in tool execution. */
export interface ToolResult {
  content: string
  /** Display-only diff for write/edit; never part of model context. */
  diff: string | null
  isError: boolean
  /** Present for a call that ran a command under a run (AH-174). */
  resources?: ToolResources
  /**
   * Set when a `bash` call failed only because this machine's null device
   * refuses sandboxed processes: an opaque id that, once the user approves,
   * runs the same call outside the sandbox via `executeToolUnsandboxedRetry`.
   * Never part of model context.
   */
  unsandboxedRetry?: string
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

/** A shell command still running in the background, as reported by
 * `bashJobsList`. Listing never consumes a job's output. */
export interface BashJobStatus {
  jobId: string
  /** Redacted: a command line is where a credential most often appears. */
  command: string
  elapsedMs: number
  /** The command has produced its output; the agent has not collected it yet. */
  finished: boolean
  /** The tool call that backgrounded it, when known. */
  callId: string | null
  /** Wall-clock start and end, epoch milliseconds. */
  startedAtMs: number
  finishedAtMs: number | null
  /** From the output's `[exit N]` marker, once finished. */
  exitCode: number | null
  /** Killed by a signal rather than exiting. */
  signalled: boolean
  /** Stopped on request (the Stop control, or the agent's own cancel). */
  stoppedByRequest: boolean
  /** The output is waiting to be collected. */
  outputAvailable: boolean
}

/** One fragment of a tool's live output. */
export type ToolOutputChunk = {
  /** Monotonic per call, so a receiver can assert ordering. */
  seq: number
  /** The tool call this belongs to; a backgrounded `bash` needs it. */
  callId: string | null
  text: string
}
