import type { MCPAuthStatus } from '@/services/mcp/types'
import { needsAuthDetail } from '@/hooks/useMcpAuth'
import { normalizeAppError } from '@/utils/appError'
import { needsAuthorization, type McpTransport } from '@/lib/mcpServerProfile'

/**
 * The connection state of one MCP server as the settings screen shows it.
 *
 * The screen used to have two signals: the saved `active` flag (the switch) and
 * membership in `getConnectedServers` (the dot). A start that failed wrote the
 * flag back and raised a global error, but nothing on the row itself said the
 * server was down or why, and a start still in flight looked the same as one
 * that had finished. This names every state the row can be in and derives it
 * from facts the page already has, so the switch, the label and the error can
 * no longer disagree.
 *
 * - `not-installed`       no configuration exists under this name
 * - `disabled`            configured, `active` is off, not running
 * - `connecting`          an activation started from this screen has not settled
 * - `connected`           the backend lists it among connected servers
 * - `needs-authorization` it cannot connect until the user signs in
 * - `failed`              the last activation from this screen threw
 * - `not-connected`       enabled but not running, with no failure recorded
 *                         here (for example it stopped, or is still starting
 *                         after launch)
 *
 * Precedence, highest first: in-flight activation, recorded failure, confirmed
 * connection, disabled, authorization required, not connected. A confirmed
 * connection outranks the flag because it is what the backend actually reports.
 */
export type McpConnectionState =
  | 'not-installed'
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'needs-authorization'
  | 'failed'
  | 'not-connected'

/** The one thing the user can do about a failure. */
export type McpNextStep = 'check-command' | 'check-url' | 'authorize' | 'retry'

export type McpActivationFailure = {
  /** Normalized, human-readable; never a raw object dump. */
  message: string
  needsAuth: boolean
  nextStep: McpNextStep
}

/** Per-server state that lives only on the settings screen. */
export type McpServerRuntime = {
  activating: boolean
  failure: McpActivationFailure | null
}

export const IDLE_RUNTIME: McpServerRuntime = {
  activating: false,
  failure: null,
}

export type McpConnectionInput = {
  /** Whether a configuration exists for this name. */
  installed: boolean
  /** The saved `active` flag. */
  enabled: boolean
  /** Whether `getConnectedServers` lists this name. */
  connected: boolean
  runtime?: McpServerRuntime
  authStatus?: MCPAuthStatus
  transport: McpTransport
}

export type McpConnectionSnapshot = {
  state: McpConnectionState
  installed: boolean
  enabled: boolean
  connected: boolean
  failure: McpActivationFailure | null
  nextStep: McpNextStep | null
  /** What the switch should show: on while starting, or when enabled. */
  switchOn: boolean
}

export function deriveConnectionState(
  input: McpConnectionInput
): McpConnectionSnapshot {
  const runtime = input.runtime ?? IDLE_RUNTIME
  const base = {
    installed: input.installed,
    enabled: input.enabled,
    connected: input.connected,
    failure: runtime.failure,
  }

  if (!input.installed) {
    return {
      ...base,
      state: 'not-installed',
      nextStep: null,
      switchOn: false,
    }
  }
  if (runtime.activating) {
    return { ...base, state: 'connecting', nextStep: null, switchOn: true }
  }
  if (runtime.failure) {
    return {
      ...base,
      state: runtime.failure.needsAuth ? 'needs-authorization' : 'failed',
      nextStep: runtime.failure.nextStep,
      switchOn: input.enabled,
    }
  }
  if (input.connected) {
    return { ...base, state: 'connected', nextStep: null, switchOn: true }
  }
  if (!input.enabled) {
    return { ...base, state: 'disabled', nextStep: null, switchOn: false }
  }
  if (needsAuthorization(input.authStatus)) {
    return {
      ...base,
      state: 'needs-authorization',
      nextStep: 'authorize',
      switchOn: true,
    }
  }
  return {
    ...base,
    state: 'not-connected',
    nextStep: stepForTransport(input.transport),
    switchOn: true,
  }
}

function stepForTransport(transport: McpTransport): McpNextStep {
  return transport === 'stdio' ? 'check-command' : 'check-url'
}

/**
 * Turn whatever activation threw into a failure the row can show. The backend
 * tags auth failures with a prefix (see `needsAuthDetail`), which is the only
 * reliable signal; everything else points at the part of the config most
 * likely to be wrong for that transport.
 */
export function classifyActivationFailure(
  error: unknown,
  transport: McpTransport
): McpActivationFailure {
  const authDetail = needsAuthDetail(error)
  if (authDetail !== null) {
    return {
      message: normalizeAppError(authDetail) || normalizeAppError(error),
      needsAuth: true,
      nextStep: 'authorize',
    }
  }
  return {
    message: normalizeAppError(error),
    needsAuth: false,
    nextStep: stepForTransport(transport),
  }
}

// Transitions. Kept as plain functions so the screen and the tests share them.

export function beginActivation(): McpServerRuntime {
  return { activating: true, failure: null }
}

/** Activation resolved and the backend lists the server as connected. */
export function activationConfirmed(): McpServerRuntime {
  return IDLE_RUNTIME
}

export function activationFailed(
  failure: McpActivationFailure
): McpServerRuntime {
  return { activating: false, failure }
}

/** Turning a server off, or removing it, discards any recorded failure. */
export function runtimeCleared(): McpServerRuntime {
  return IDLE_RUNTIME
}
