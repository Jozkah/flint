import {
  toJanMcpConfig,
  type CompatState,
  type McpConfinementRequest,
  type McpProbe,
} from '@/lib/claudeCompat'
import { errorText } from '@/lib/errorText'

/**
 * Bringing an imported MCP server up, and taking it down again.
 *
 * The adapter that turns a Claude definition into a Flint config was already
 * tested; this is what actually drives Flint's MCP subsystem with it. Kept as a
 * separate module taking its subsystem as an argument because the interesting
 * behaviour is all timing — a server that has consented but not initialized, a
 * handshake that fails, a disable arriving while a call is in flight — and
 * none of that is reachable through a mounted route.
 *
 * The rule the whole module exists to enforce: nothing is `active` until the
 * subsystem says the server initialized. Consent is permission to try, not a
 * report that it worked.
 */

/** Where one imported server has got to. */
export type McpRuntimeState =
  /** Found in configuration. Nothing has been asked of the user yet. */
  | 'detected'
  | 'consent-required'
  /** Handed to the subsystem; the handshake has not finished. */
  | 'initializing'
  /** Up, handshaken, tools published. */
  | 'active'
  | 'init-failed'
  /** Being taken down. */
  | 'stopping'
  | 'disabled'
  | 'unsupported'

/** The part of Flint's MCP subsystem this needs. */
export type McpRuntime = {
  activate: (name: string, config: unknown) => Promise<void>
  deactivate: (name: string) => Promise<void>
  connected: () => Promise<string[]>
  toolsFor: (names: string[]) => Promise<{ name: string }[]>
}

export type McpRuntimeRecord = {
  state: McpRuntimeState
  /** Why, where the reason is the whole content. */
  reason?: string
  /** Published only once the server is actually up. */
  tools: string[]
  /** The definition this state belongs to. */
  fingerprint: string
}

/**
 * The exact definition consent was given for.
 *
 * Consent means "run *this*". Changing the executable, the endpoint, the
 * transport, the arguments, the environment it will be handed or where it
 * runs makes it a different program, and a consent carried across that change
 * would be permission the user never gave. Environment *names* are part of the
 * fingerprint; values never reach this module at all.
 *
 * Scope: this only detects that a repository's `.mcp.json` entry changed under
 * an import consent, before Flint has built a server config from it. It is not
 * the identity tool approvals are bound to. Tool trust (the backend gate and
 * the renderer approval store) uses the backend's `mcp_identity` fingerprint of
 * the config Flint actually runs, fetched through `serverFingerprints()`, and
 * nothing that grants a tool call compares this value.
 */
export function fingerprintMcp(probe: McpProbe): string {
  return JSON.stringify([
    probe.name,
    probe.transport ?? (probe.command ? 'stdio' : null),
    probe.command ?? null,
    [...(probe.args ?? [])],
    probe.url ?? null,
    [...(probe.envNames ?? [])].sort(),
    probe.cwd ?? null,
  ])
}

/** Has the definition changed under a consent that was given earlier? */
export const consentStillMatches = (
  probe: McpProbe,
  consentedFingerprint: string | undefined
): boolean =>
  consentedFingerprint !== undefined &&
  consentedFingerprint === fingerprintMcp(probe)

/**
 * Bring one consented server up through the real subsystem.
 *
 * Ordered so the manifest can never claim more than has happened: the record
 * goes to `initializing` before the call, and only reaches `active` after the
 * subsystem reports the server connected *and* its tools have been read. A
 * server that activates without appearing in the connected list did not come
 * up, whatever the activate call returned.
 */
export async function startImportedMcp(
  probe: McpProbe,
  runtime: McpRuntime,
  onState: (record: McpRuntimeRecord) => void,
  /**
   * How the backend must confine this server, for a local one.
   *
   * Absent for a remote server, which starts no process here. Absent for a
   * local one means the backend refuses it: an imported server with no
   * confinement fails closed rather than running unconfined.
   */
  confinement?: McpConfinementRequest
): Promise<McpRuntimeRecord> {
  const fingerprint = fingerprintMcp(probe)
  const config = toJanMcpConfig(probe, confinement)
  if (!config) {
    const record: McpRuntimeRecord = {
      state: 'unsupported',
      reason: 'no transport Flint can represent',
      tools: [],
      fingerprint,
    }
    onState(record)
    return record
  }

  onState({ state: 'initializing', tools: [], fingerprint })

  try {
    await runtime.activate(probe.name, config)
  } catch (e) {
    const record: McpRuntimeRecord = {
      state: 'init-failed',
      reason: errorText(e),
      tools: [],
      fingerprint,
    }
    onState(record)
    return record
  }

  let connected: string[]
  try {
    connected = await runtime.connected()
  } catch (e) {
    connected = []
    void e
  }
  if (!connected.includes(probe.name)) {
    // Activate resolving is not the handshake finishing. Saying `active` here
    // would advertise tools that do not exist.
    const record: McpRuntimeRecord = {
      state: 'init-failed',
      reason: 'the server did not connect',
      tools: [],
      fingerprint,
    }
    onState(record)
    return record
  }

  let tools: string[] = []
  try {
    tools = (await runtime.toolsFor([probe.name])).map((one) => one.name)
  } catch (e) {
    const record: McpRuntimeRecord = {
      state: 'init-failed',
      reason: errorText(e),
      tools: [],
      fingerprint,
    }
    onState(record)
    return record
  }

  const record: McpRuntimeRecord = { state: 'active', tools, fingerprint }
  onState(record)
  return record
}

/**
 * Take one server down.
 *
 * Reports what actually happened rather than what was asked for: a shutdown
 * that failed leaves the record saying so, because a server reported stopped
 * while its process is still up is the one lie that would let a caller believe
 * a boundary had been restored when it had not. Its tools are withdrawn only
 * on a shutdown that succeeded, so a failed stop cannot strand a call against
 * a server the manifest has already forgotten.
 */
export async function stopImportedMcp(
  name: string,
  fingerprint: string,
  runtime: McpRuntime,
  onState: (record: McpRuntimeRecord) => void
): Promise<McpRuntimeRecord> {
  onState({ state: 'stopping', tools: [], fingerprint })
  try {
    await runtime.deactivate(name)
  } catch (e) {
    const record: McpRuntimeRecord = {
      state: 'init-failed',
      reason: `could not stop: ${errorText(e)}`,
      tools: [],
      fingerprint,
    }
    onState(record)
    return record
  }
  const record: McpRuntimeRecord = { state: 'disabled', tools: [], fingerprint }
  onState(record)
  return record
}

/**
 * Fold real runtime state back into the manifest's vocabulary.
 *
 * The manifest is what readiness renders, so it has to reflect what the
 * subsystem is actually doing rather than what the configuration allows.
 */
export function compatStateFor(
  record: McpRuntimeRecord | undefined,
  fallback: CompatState
): CompatState {
  if (!record) return fallback
  switch (record.state) {
    case 'active':
      return 'active'
    case 'initializing':
    case 'stopping':
      // Neither usable yet nor failed. Reported as still starting rather than
      // as either end state.
      return 'consent-required'
    case 'init-failed':
      return 'init-failed'
    case 'disabled':
      return 'disabled'
    case 'unsupported':
      return 'unsupported'
    default:
      return fallback
  }
}
