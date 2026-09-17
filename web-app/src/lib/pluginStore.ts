import { invoke } from '@tauri-apps/api/core'

/**
 * Project plugins: packages under `<folder>/.jan/agent/plugins/<id>/` that add
 * skills, slash commands and agent profiles to one project.
 *
 * Thin typed wrappers over the `agent_plugin_*` Tauri commands. Every command
 * rejects with `{ code, message }`; `toPluginError` normalizes whatever the
 * bridge hands back so callers branch on `code` and never parse a sentence.
 */

export type PluginSourceKind = 'local' | 'git' | 'marketplace'

export interface InstalledPlugin {
  /** Directory name: the identity every other command takes. */
  id: string
  name: string
  description: string
  version: string
  repo: string
  skills: number
  commands: number
  agents: number
  enabled: boolean
  /** Absent for a directory Flint did not install (copied in by hand). */
  sourceKind: PluginSourceKind | null
  source: string | null
}

export interface PluginDetails extends InstalledPlugin {
  installedPath: string
  installedAtMs: number | null
  gitRef: string | null
  skillNames: string[]
  commandNames: string[]
  agentNames: string[]
  /** The plugin ships a `.mcp.json`. Flint does not load it. */
  hasMcpConfig: boolean
  executableFiles: string[]
  executableFileCount: number
}

export interface RemoveReport {
  id: string
  name: string
  removedPath: string
  removedFromDisabled: boolean
  removedSkillEntries: string[]
}

export interface PluginSources {
  /** Configured marketplace index URL; null when none is configured. */
  marketplace: string | null
  gitAvailable: boolean
}

export type InstallSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string }
  | { kind: 'marketplace'; name: string }

/** Mirrors `PluginErrorCode` in `src-tauri/src/core/agent/plugins.rs`. */
export const PLUGIN_ERROR_CODES = [
  'invalid_source',
  'source_not_found',
  'no_plugin_content',
  'collection',
  'already_installed',
  'invalid_name',
  'not_installed',
  'git_unavailable',
  'git_failed',
  'marketplace_not_configured',
  'marketplace_unavailable',
  'marketplace_entry_not_found',
  'cancelled',
  'project_unavailable',
  'config',
  'io',
] as const

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number] | 'unknown'

export class PluginError extends Error {
  readonly code: PluginErrorCode
  constructor(code: PluginErrorCode, message: string) {
    super(message)
    this.name = 'PluginError'
    this.code = code
  }
}

const isKnownCode = (value: unknown): value is PluginErrorCode =>
  typeof value === 'string' &&
  (PLUGIN_ERROR_CODES as readonly string[]).includes(value)

/** Normalize an invoke rejection (typed object, string, Error) to a PluginError. */
export function toPluginError(error: unknown): PluginError {
  if (error instanceof PluginError) return error
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    const message =
      typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'Unknown error'
    return new PluginError(
      isKnownCode(record.code) ? record.code : 'unknown',
      message
    )
  }
  if (typeof error === 'string' && error.trim()) {
    return new PluginError('unknown', error.trim())
  }
  return new PluginError('unknown', 'Unknown error')
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Actionable text for an error: a per-code explanation of what to do, with the
 * backend's own message as detail so nothing specific is lost.
 */
export function pluginErrorText(t: Translate, error: unknown): string {
  const e = toPluginError(error)
  return t(`plugins:errors.${e.code}`, { detail: e.message })
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toPluginError(error)
  }
}

/** Store a command targets: the project's `.jan/agent/plugins/` (default), or
 *  the user's own global plugin store shared by every workspace. */
export type PluginScope = 'project' | 'global'

const scopeArgs = (scope: PluginScope | undefined) =>
  scope === 'global' ? { scope: 'global' } : {}

export const listPlugins = (project: string, scope?: PluginScope) =>
  call<InstalledPlugin[]>('agent_plugin_list', { project, ...scopeArgs(scope) })

export const getPluginDetails = (project: string, id: string, scope?: PluginScope) =>
  call<PluginDetails>('agent_plugin_details', { project, id, ...scopeArgs(scope) })

export const getPluginSources = (project: string, scope?: PluginScope) =>
  call<PluginSources>('agent_plugin_sources', { project, ...scopeArgs(scope) })

export const installPlugin = (
  project: string,
  source: InstallSource,
  operationId: string,
  scope?: PluginScope
) =>
  call<InstalledPlugin>('agent_plugin_install', {
    project,
    source,
    operationId,
    ...scopeArgs(scope),
  })

/** Resolves false when no install with that id is running any more. */
export const cancelPluginInstall = (operationId: string) =>
  call<boolean>('agent_plugin_install_cancel', { operationId })

export const setPluginEnabled = (
  project: string,
  id: string,
  enabled: boolean,
  scope?: PluginScope
) =>
  call<InstalledPlugin>('agent_plugin_set_enabled', {
    project,
    id,
    enabled,
    ...scopeArgs(scope),
  })

export const removePlugin = (project: string, id: string, scope?: PluginScope) =>
  call<RemoveReport>('agent_plugin_remove', { project, id, ...scopeArgs(scope) })

/** A plugin entry on the configured marketplace index. */
export interface MarketEntry {
  name: string
  description: string
  repo: string
  ref: string | null
}

/** Search the configured plugin marketplace (contacts the index URL). Scope
 *  is accepted for API symmetry with the other wrappers; the backend command
 *  does not currently branch on it. */
export const searchPlugins = (query: string, scope?: PluginScope) => {
  void scope
  return call<MarketEntry[]>('agent_plugin_search', { project: '', query })
}

export type GitUrlCheck =
  | { ok: true; host: string }
  | { ok: false; reason: 'empty' | 'format' }

/**
 * Validate a git URL the way the install form needs it: https://, ssh:// or
 * scp-like `git@host:path`, and report the host the clone will contact.
 * Shell metacharacters are refused here as they are in the backend.
 */
export function checkGitUrl(input: string): GitUrlCheck {
  const value = input.trim()
  if (!value) return { ok: false, reason: 'empty' }
  if (/[;&|`$(){}<>\\\s]/.test(value)) return { ok: false, reason: 'format' }
  const scp = /^git@([^:/]+):[^\s]+$/.exec(value)
  if (scp) return { ok: true, host: scp[1] }
  try {
    const url = new URL(value)
    if (!['https:', 'ssh:', 'http:'].includes(url.protocol) || !url.hostname) {
      return { ok: false, reason: 'format' }
    }
    if (url.pathname.replace(/\/+/g, '/') === '/') {
      return { ok: false, reason: 'format' }
    }
    return { ok: true, host: url.hostname }
  } catch {
    return { ok: false, reason: 'format' }
  }
}

/** Host of a URL, for labelling what a configured marketplace contacts. */
export function urlHost(value: string): string {
  try {
    return new URL(value).hostname || value
  } catch {
    return value
  }
}
