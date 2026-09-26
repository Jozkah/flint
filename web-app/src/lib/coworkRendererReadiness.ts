/**
 * The Environment rows only the renderer can answer for.
 *
 * The backend probes the folder, shell and sandbox itself and leaves model,
 * context, MCP and local runtime as "checking" until someone who holds those
 * facts reports them. Nobody did: the session details panel called the probe
 * without `reported`, so those four rows said "Checking…" forever. This builds
 * the reports from what the Cowork page already knows, so every row ends in an
 * answer with a reason.
 */
import type { ComponentReport } from '@janhq/tauri-plugin-agent-tools-api'

export type RendererReadinessFacts = {
  /** The model this session would run, if one is selected. */
  model: { id: string; provider: string; supportsTools: boolean | null } | null
  /** The resolved context window, or null when no source gave one. */
  contextTokens: number | null
  /** Active MCP servers in Settings. Cowork runs are given none of them. */
  settingsMcpServers: number
}

const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

const at = (
  now: number,
  one: Omit<ComponentReport, 'checkedAtMs' | 'details'> & { details?: string[] }
): ComponentReport => ({ details: [], ...one, checkedAtMs: now })

export function rendererReadinessReports(
  facts: RendererReadinessFacts,
  now: number = Date.now()
): ComponentReport[] {
  const { model } = facts
  const reports: ComponentReport[] = []

  if (!model) {
    reports.push(
      at(now, {
        component: 'model',
        state: 'unavailable',
        reason: 'model-unselected',
        message: 'No model is selected for this session.',
        retryable: true,
        capabilities: [],
      })
    )
  } else if (model.supportsTools === false) {
    reports.push(
      at(now, {
        component: 'model',
        state: 'degraded',
        reason: 'ok',
        message:
          'The selected model cannot call tools, so Cowork can only chat with it.',
        retryable: false,
        capabilities: ['model.dispatch'],
        details: [`provider=${model.provider}`],
      })
    )
  } else {
    reports.push(
      at(now, {
        component: 'model',
        state: 'ready',
        reason: 'ok',
        message:
          'A model is selected. Whether the provider answers is checked when a run starts.',
        retryable: false,
        capabilities: ['model.dispatch', 'model.tools'],
        details: [`provider=${model.provider}`],
      })
    )
  }

  reports.push(
    facts.contextTokens && facts.contextTokens > 0
      ? at(now, {
          component: 'context',
          state: 'ready',
          reason: 'ok',
          message: `Context window: ${facts.contextTokens.toLocaleString()} tokens.`,
          retryable: false,
          capabilities: ['context.known'],
        })
      : at(now, {
          component: 'context',
          state: 'degraded',
          reason: 'context-unknown',
          message:
            'The context window could not be found for this model, so Flint cannot warn before it fills up.',
          retryable: true,
          capabilities: [],
        })
  )

  reports.push(
    at(now, {
      component: 'mcp',
      state: 'blocked',
      reason: 'mcp-none-configured',
      message:
        facts.settingsMcpServers > 0
          ? 'MCP servers from Settings are not offered to Cowork runs.'
          : 'No MCP servers are configured.',
      retryable: false,
      capabilities: [],
    })
  )

  const local = model != null && LOCAL_PROVIDERS.has(model.provider)
  reports.push(
    local
      ? at(now, {
          component: 'local-runtime',
          state: 'ready',
          reason: 'ok',
          message: 'The local runtime is started when a run needs the model.',
          retryable: false,
          capabilities: [],
        })
      : at(now, {
          component: 'local-runtime',
          state: 'blocked',
          reason: 'local-runtime-absent',
          message: 'The selected model is not run locally.',
          retryable: false,
          capabilities: [],
        })
  )

  return reports
}
