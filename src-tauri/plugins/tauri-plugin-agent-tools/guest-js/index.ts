import { invoke, Channel } from '@tauri-apps/api/core'
import {
  BashJobStatus,
  ProjectFile,
  ProjectListing,
  SkillMeta,
  ToolOutputChunk,
  ToolResult,
  ToolSchema,
  WorkspaceScope,
} from './types'

export {
  BashJobStatus,
  ProjectEntry,
  ProjectFile,
  ProjectListing,
  SkillMeta,
  ToolOutputChunk,
  ToolResult,
  ToolSchema,
  WorkspaceScope,
} from './types'

/**
 * Every call takes the Jan data folder, because the plugin derives its
 * directories from it (`<dataFolder>/agent-workspace`) while the app remains the
 * owner of where the data folder actually is.
 *
 * Two roots, with different lifetimes:
 *
 * - the **permanent store** (`memory/`, `skills/`) survives every conversation
 * - a **thread sandbox** (`threads/<threadId>/`) is where the filesystem tools
 *   run and is deleted with its thread
 *
 * `project` overrides which store is used and is unused for now: there is no
 * project picker yet. It exists so adding one later needs no signature change.
 */

/** Ensure the permanent store exists and return its path. */
export async function workspacePath(dataFolder: string): Promise<string> {
  return await invoke('plugin:agent-tools|workspace_path', { dataFolder })
}

/** Ensure a thread's sandbox exists and return its path. */
export async function threadWorkspacePath(
  dataFolder: string,
  threadId: string
): Promise<string> {
  return await invoke('plugin:agent-tools|thread_workspace_path', {
    dataFolder,
    threadId,
  })
}

/**
 * Delete a thread's sandbox. Memory and skills are untouched. Idempotent: a
 * thread that never ran a tool resolves successfully.
 */
export async function threadWorkspaceDelete(
  dataFolder: string,
  threadId: string
): Promise<void> {
  return await invoke('plugin:agent-tools|thread_workspace_delete', {
    dataFolder,
    threadId,
  })
}

/**
 * Delete every sandbox not belonging to a surviving thread, returning how many
 * were removed. For startup: a crash, or a thread deleted while the app was
 * closed, would otherwise leave one behind.
 */
export async function threadWorkspaceSweep(
  dataFolder: string,
  keep: string[]
): Promise<number> {
  return await invoke('plugin:agent-tools|thread_workspace_sweep', {
    dataFolder,
    keep,
  })
}

/** The Cowork session sandbox, created if absent. */
export async function sessionWorkspacePath(
  dataFolder: string,
  sessionId: string
): Promise<string> {
  return await invoke('plugin:agent-tools|session_workspace_path', {
    dataFolder,
    sessionId,
  })
}

/**
 * Can this platform confine both the file tools and the shell to a folder?
 *
 * Asked before offering to edit a folder directly, so an option that could not
 * be enforced is never shown rather than failing after the user confirms it.
 */
export async function directEditCapability(): Promise<boolean> {
  return await invoke('plugin:agent-tools|direct_edit_capability')
}

/**
 * Authorize this session to edit `folder`, returning an opaque grant id.
 *
 * The id is what runs carry afterwards; a path is never accepted at tool time,
 * so nothing a model emits can widen or redirect what a run may write.
 */
export async function directEditAuthorize(
  dataFolder: string,
  sessionId: string,
  folder: string
): Promise<string> {
  return await invoke('plugin:agent-tools|direct_edit_authorize', {
    dataFolder,
    sessionId,
    folder,
  })
}

/** Withdraw one grant. Succeeds whether or not it was still live. */
export async function directEditRevoke(grantId: string): Promise<boolean> {
  return await invoke('plugin:agent-tools|direct_edit_revoke', { grantId })
}

/** Withdraw every grant a session holds. */
export async function directEditRevokeSession(
  sessionId: string
): Promise<number> {
  return await invoke('plugin:agent-tools|direct_edit_revoke_session', {
    sessionId,
  })
}

/** Delete a Cowork session's sandbox, with its scratch. */
export async function sessionWorkspaceDelete(
  dataFolder: string,
  sessionId: string
): Promise<void> {
  await invoke('plugin:agent-tools|session_workspace_delete', {
    dataFolder,
    sessionId,
  })
}

/**
 * Collect session sandboxes whose sessions no longer exist, returning how many
 * were removed. Separate from the thread sweep: the id spaces are independent,
 * and an empty `keep` is a no-op rather than a full wipe.
 */
export async function sessionWorkspaceSweep(
  dataFolder: string,
  keep: string[]
): Promise<number> {
  return await invoke('plugin:agent-tools|session_workspace_sweep', {
    dataFolder,
    keep,
  })
}

export async function skillList(
  dataFolder: string,
  project?: string
): Promise<SkillMeta[]> {
  return await invoke('plugin:agent-tools|skill_list', { dataFolder, project })
}

/** Raw SKILL.md text, frontmatter included. */
export async function skillRead(
  dataFolder: string,
  name: string,
  project?: string
): Promise<string> {
  return await invoke('plugin:agent-tools|skill_read', {
    dataFolder,
    project,
    name,
  })
}

/** Create or overwrite a skill. New skills are written as `<name>/SKILL.md`. */
export async function skillWrite(
  dataFolder: string,
  name: string,
  content: string,
  project?: string
): Promise<void> {
  return await invoke('plugin:agent-tools|skill_write', {
    dataFolder,
    project,
    name,
    content,
  })
}

/** Delete a skill. Idempotent: a missing skill resolves successfully. */
export async function skillDelete(
  dataFolder: string,
  name: string,
  project?: string
): Promise<void> {
  return await invoke('plugin:agent-tools|skill_delete', {
    dataFolder,
    project,
    name,
  })
}

/** Memory note names (stems), sorted. */
export async function memoryList(
  dataFolder: string,
  project?: string
): Promise<string[]> {
  return await invoke('plugin:agent-tools|memory_list', { dataFolder, project })
}

export async function memoryRead(
  dataFolder: string,
  name: string,
  project?: string
): Promise<string> {
  return await invoke('plugin:agent-tools|memory_read', {
    dataFolder,
    project,
    name,
  })
}

export async function memoryWrite(
  dataFolder: string,
  name: string,
  content: string,
  project?: string
): Promise<void> {
  return await invoke('plugin:agent-tools|memory_write', {
    dataFolder,
    project,
    name,
    content,
  })
}

/** Delete a memory note. Idempotent: a missing note resolves successfully. */
export async function memoryDelete(
  dataFolder: string,
  name: string,
  project?: string
): Promise<void> {
  return await invoke('plugin:agent-tools|memory_delete', {
    dataFolder,
    project,
    name,
  })
}

/**
 * Function schemas for every built-in tool. Callers pick which subset to
 * advertise; the schemas are never re-typed in TypeScript.
 */
export async function toolSchemas(): Promise<ToolSchema[]> {
  return await invoke('plugin:agent-tools|tool_schemas')
}

/**
 * List one directory level of the attached read-only project, filtered
 * (`.git`, dependency folders, gitignored files) and sorted directories-first.
 * Root containment is enforced in Rust; `rel` may not escape `root`.
 */
export async function projectListDir(
  dataFolder: string,
  root: string,
  rel: string
): Promise<ProjectListing> {
  return await invoke('plugin:agent-tools|project_list_dir', {
    dataFolder,
    root,
    rel,
  })
}

/**
 * Read one project file verbatim for the code viewer. Oversized and binary
 * files come back flagged with empty content; sensitive files (`.env`, keys)
 * are refused unless `allowSensitive` marks an explicit user override.
 */
export async function projectReadFile(
  dataFolder: string,
  root: string,
  rel: string,
  allowSensitive?: boolean
): Promise<ProjectFile> {
  return await invoke('plugin:agent-tools|project_read_file', {
    dataFolder,
    root,
    rel,
    allowSensitive,
  })
}

/**
 * Shell commands still running in the background, newest first.
 *
 * Read-only: polling this never takes the output the agent collects with
 * `bash {"job_id": ...}`, so a UI can show live jobs without racing the run.
 */
export async function bashJobsList(): Promise<BashJobStatus[]> {
  return await invoke('plugin:agent-tools|bash_jobs_list')
}

/** Why a kill request ended the way it did. Mirrors `BashJobKillOutcome`. */
export type BashJobKillOutcome =
  /** The process tree was signalled. */
  | 'killed'
  /** The command had already finished; its output is still collectable. */
  | 'alreadyFinished'
  /** No job by that id: never existed, or already collected. */
  | 'unknown'
  /** The job exists but no pid was ever captured, so nothing was signalled. */
  | 'noPid'
  /** The OS refused. The command is still running and can be asked again. */
  | 'failed'

export type BashJobKill = {
  jobId: string
  outcome: BashJobKillOutcome
  /** Why it failed, when it did. Safe to show: it names the OS refusal. */
  error?: string | null
}

/**
 * Kill one backgrounded shell command and every process it spawned.
 *
 * The job entry survives, so the agent's own collection still returns whatever
 * the command printed before it died. The outcome is reported rather than
 * assumed: a UI must not claim to have stopped something that had already
 * finished, or that it could not signal.
 */
export async function bashJobKill(jobId: string): Promise<BashJobKill> {
  return await invoke('plugin:agent-tools|bash_job_kill', { jobId })
}

/** Which OS sandbox, if any, can confine a shell on this machine. */
export type SandboxStatus = {
  /** `bubblewrap`, `seatbelt`, `appcontainer`, or `none`. */
  backend: string
  enforces: boolean
}

/** One independently-probed part of a session's environment. */
export type ReadinessComponent =
  | 'model'
  | 'context'
  | 'filesystem'
  | 'shell'
  | 'sandbox'
  | 'mcp'
  | 'workspace'
  | 'local-runtime'

/**
 * How a component is doing.
 *
 * `checking` is not a failure and `degraded` is not `unavailable`: a shell that
 * can only run `cmd` still runs shell-neutral commands, and treating the two
 * the same would withhold work that would have succeeded.
 */
export type ReadinessState =
  | 'checking'
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'blocked'

/**
 * A stable machine-readable cause. Chosen to survive rewording of the message
 * beside it, because tests and UI guidance key off these.
 */
export type ReadinessReason =
  | 'ok'
  | 'not-probed'
  | 'workspace-missing'
  | 'workspace-unattached'
  | 'filesystem-unreadable'
  | 'filesystem-read-only'
  | 'shell-missing'
  | 'shell-runtime-incompatible'
  | 'shell-probe-failed'
  | 'shell-non-posix-only'
  | 'sandbox-unavailable'
  | 'sandbox-disabled'
  | 'model-unselected'
  | 'model-unreachable'
  | 'context-unknown'
  | 'mcp-none-configured'
  | 'mcp-unreachable'
  | 'local-runtime-absent'
  | 'local-runtime-stopped'

export type ComponentReport = {
  component: ReadinessComponent
  state: ReadinessState
  reason: ReadinessReason
  /** One actionable sentence. Never a value, a path, a command or a secret. */
  message: string
  /** Unix milliseconds; null when the component has not been probed. */
  checkedAtMs: number | null
  retryable: boolean
  /** What this component grants right now. Empty when it is not usable. */
  capabilities: string[]
  /** Extra lines for a copied diagnostic, under the same redaction rules. */
  details: string[]
}

export type EnvironmentReadiness = {
  components: ComponentReport[]
  generatedAtMs: number
}

/** A tool held back, and which component is responsible. */
export type OmittedTool = {
  name: string
  component: ReadinessComponent
  reason: ReadinessReason
  message: string
}

export type AdvertisedTools = {
  schemas: ToolSchema[]
  omitted: OmittedTool[]
}

/**
 * What this session can do right now, component by component.
 *
 * `reported` carries the components only the renderer's stores can answer for
 * -- whether a provider replied, what context window was resolved, which MCP
 * servers connected. Rust decides what those facts mean and refuses any claim
 * about a component it probes itself, so a caller cannot assert that a shell
 * works.
 */
export async function environmentReadiness(
  projectRoot?: string,
  reported?: ComponentReport[]
): Promise<EnvironmentReadiness> {
  return await invoke('plugin:agent-tools|environment_readiness', {
    projectRoot,
    reported,
  })
}

/**
 * Re-probe one component, or every backend-owned component when `component` is
 * omitted. One at a time by default, so the timestamps beside the untouched
 * rows keep telling the truth about when they were last checked.
 */
export async function environmentReadinessRetry(
  projectRoot?: string,
  component?: ReadinessComponent,
  reported?: ComponentReport[]
): Promise<EnvironmentReadiness> {
  return await invoke('plugin:agent-tools|environment_readiness_retry', {
    projectRoot,
    component,
    reported,
  })
}

/**
 * The tools this environment can actually run, and the ones it cannot with the
 * reason. Prefer this to `toolSchemas` when building what a model is offered:
 * a tool the model calls and cannot use costs a turn and reads as a defect.
 */
export async function advertisedToolSchemas(
  projectRoot?: string,
  reported?: ComponentReport[]
): Promise<AdvertisedTools> {
  return await invoke('plugin:agent-tools|advertised_tool_schemas', {
    projectRoot,
    reported,
  })
}

/**
 * Report the sandbox backend. Callers should advertise `bash` to a model only
 * when this reports `enforces`: without a backend every call is refused, and
 * offering a tool that cannot run wastes a turn and reads as a bug.
 */
export async function sandboxStatus(): Promise<SandboxStatus> {
  return await invoke('plugin:agent-tools|sandbox_status')
}

/**
 * Execute one built-in tool.
 *
 * The filesystem tools run in `threadId`'s sandbox, which is created on demand,
 * so the caller need not ensure it first. Memory and skill tools reach the
 * permanent store instead, so what the model records outlives the conversation.
 *
 * The permission gate decides in Rust, so tools that need user approval
 * (`write`, `edit`, and reads that escape the sandbox) reject regardless of what
 * is requested here. `bash` runs only under an enforcing OS sandbox; see
 * `sandboxStatus`.
 *
 * `allowNetwork` opens the sandboxed shell's network namespace. It defaults to
 * off, so omitting it is the safe choice.
 *
 * `scope` picks the sandbox namespace: chat threads and Cowork sessions have
 * independent id spaces and independent sweeps.
 *
 * `callId` is echoed on every streamed output chunk, which a backgrounded
 * `bash` needs because it keeps producing output after the tool has returned.
 *
 * `readOnlyProject` attaches a folder the tools may read but never write. It is
 * validated on the Rust side and rejected outright if it overlaps the workspace
 * or the Jan data folder, rather than being silently dropped.
 */
export async function executeTool(
  dataFolder: string,
  threadId: string,
  name: string,
  args: Record<string, unknown>,
  project?: string,
  enabledSkills?: string[],
  allowNetwork?: boolean,
  readOnlyProject?: string,
  writeGrant?: string,
  scope?: WorkspaceScope,
  callId?: string
): Promise<ToolResult> {
  return await invoke('plugin:agent-tools|execute_tool', {
    dataFolder,
    threadId,
    project,
    name,
    args,
    enabledSkills,
    allowNetwork,
    readOnlyProject,
    writeGrant,
    scope,
    callId,
  })
}

/**
 * `executeTool`, with the tool's output delivered as it is produced.
 *
 * A separate command rather than an optional argument: a Tauri `Channel` is a
 * command argument, not a deserialisable value, so it cannot be wrapped in an
 * optional. Chunks carry a monotonic `seq` and the `callId` they belong to.
 */
export async function executeToolStreaming(
  dataFolder: string,
  threadId: string,
  name: string,
  args: Record<string, unknown>,
  onOutput: Channel<ToolOutputChunk>,
  options?: {
    project?: string
    enabledSkills?: string[]
    allowNetwork?: boolean
    readOnlyProject?: string
    writeGrant?: string
    scope?: WorkspaceScope
    callId?: string
  }
): Promise<ToolResult> {
  return await invoke('plugin:agent-tools|execute_tool_streaming', {
    dataFolder,
    threadId,
    name,
    args,
    onOutput,
    project: options?.project,
    enabledSkills: options?.enabledSkills,
    allowNetwork: options?.allowNetwork,
    readOnlyProject: options?.readOnlyProject,
    writeGrant: options?.writeGrant,
    scope: options?.scope,
    callId: options?.callId,
  })
}
