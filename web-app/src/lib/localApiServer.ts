import { guardServerStart } from '@/lib/utils'

/** What the Local API Server is started with; the settings page and the app-start path share it. */
export type LocalApiServerConfig = {
  serverHost: string
  serverPort: number
  apiPrefix: string
  apiKey: string
  trustedHosts: string[]
  corsEnabled: boolean
  verboseLogs: boolean
  proxyTimeout: number
  enableServerToolExecution: boolean
}

/**
 * Starts the server and resolves with the port it actually bound (it falls
 * back to a free one when the configured port is taken). Waits at most the
 * start watchdog and tears the server down when that expires.
 */
export function startLocalApiServer(
  config: LocalApiServerConfig
): Promise<number | undefined> {
  return guardServerStart(
    window.core?.api?.startServer({
      host: config.serverHost,
      port: config.serverPort,
      prefix: config.apiPrefix,
      apiKey: config.apiKey,
      trustedHosts: config.trustedHosts,
      isCorsEnabled: config.corsEnabled,
      isVerboseEnabled: config.verboseLogs,
      proxyTimeout: config.proxyTimeout,
      // Omitted, the backend reads it as false and silently turns off the
      // setting the user enabled (#156).
      enableServerToolExecution: config.enableServerToolExecution,
    })
  )
}

/** The `{ model, provider }` pairs behind the model ids that are loaded now. */
export function serverModelsFromActive(
  activeIds: readonly string[],
  providers: ReadonlyArray<{
    provider: string
    models?: ReadonlyArray<{ id: string }>
  }>
): { model: string; provider: string }[] {
  return activeIds.flatMap((id) => {
    const owner = providers.find((p) => p?.models?.some((m) => m.id === id))
    return owner ? [{ model: id, provider: owner.provider }] : []
  })
}

export type ServerStartFailure = {
  /** Which message to show: the port is taken, the model step failed, or the server call did. */
  kind: 'port-in-use' | 'model' | 'server'
  message: string
}

/**
 * Sorts a failed start. Which step failed decides the answer: anything before
 * the server call is the model step, and the server call answers with a stable
 * `code` (`start_server` rejects with `{ code, message }`).
 */
export function classifyServerStartError(
  error: unknown,
  phase: 'model' | 'server'
): ServerStartFailure {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined
  if (phase === 'server' && code === 'PORT_IN_USE') {
    return { kind: 'port-in-use', message }
  }
  return { kind: phase, message }
}
