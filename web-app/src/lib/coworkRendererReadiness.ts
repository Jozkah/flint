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
import { i18n } from '@/i18n/react-i18next-compat'

export type RendererReadinessFacts = {
  /** The model this session would run, if one is selected. */
  model: {
    id: string
    provider: string
    supportsTools: boolean | null
    /**
     * What a Model Doctor probe observed under the current settings, when one
     * ran. An observation outranks the declared flag, and says when it was made.
     */
    observedTools?: { outcome: 'passed' | 'failed'; testedAt: string; detail?: string } | null
  } | null
  /** The resolved context window, or null when no source gave one. */
  contextTokens: number | null
  /** Active MCP servers in Settings; Cowork runs are offered the connected ones. */
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
        message: i18n.t('common:coworkReadiness.noModel'),
        retryable: true,
        capabilities: [],
      })
    )
  } else if (model.observedTools?.outcome === 'failed') {
    reports.push(
      at(now, {
        component: 'model',
        state: 'degraded',
        reason: 'ok',
        message: model.observedTools.detail
          ? i18n.t('common:coworkReadiness.toolsFailedDetail', {
              date: model.observedTools.testedAt,
              detail: model.observedTools.detail,
            })
          : i18n.t('common:coworkReadiness.toolsFailed', { date: model.observedTools.testedAt }),
        retryable: true,
        capabilities: ['model.dispatch'],
        details: [`provider=${model.provider}`, 'observed=model-doctor'],
      })
    )
  } else if (model.supportsTools === false && model.observedTools?.outcome !== 'passed') {
    reports.push(
      at(now, {
        component: 'model',
        state: 'degraded',
        reason: 'ok',
        message: i18n.t('common:coworkReadiness.noToolSupport'),
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
        message: model.observedTools
          ? i18n.t('common:coworkReadiness.modelToolsWorked', { date: model.observedTools.testedAt })
          : i18n.t('common:coworkReadiness.modelSelected'),
        retryable: false,
        capabilities: ['model.dispatch', 'model.tools'],
        details: model.observedTools
          ? [`provider=${model.provider}`, 'observed=model-doctor']
          : [`provider=${model.provider}`],
      })
    )
  }

  reports.push(
    facts.contextTokens && facts.contextTokens > 0
      ? at(now, {
          component: 'context',
          state: 'ready',
          reason: 'ok',
          message: i18n.t('common:coworkReadiness.contextWindow', { tokens: facts.contextTokens.toLocaleString() }),
          retryable: false,
          capabilities: ['context.known'],
        })
      : at(now, {
          component: 'context',
          state: 'degraded',
          reason: 'context-unknown',
          message: i18n.t('common:coworkReadiness.contextUnknown'),
          retryable: true,
          capabilities: [],
        })
  )

  reports.push(
    facts.settingsMcpServers > 0
      ? at(now, {
          component: 'mcp',
          state: 'ready',
          reason: 'ok',
          message: i18n.t('common:coworkReadiness.mcpOffered', { count: facts.settingsMcpServers }),
          retryable: false,
          capabilities: ['mcp.offered'],
        })
      : at(now, {
          component: 'mcp',
          state: 'blocked',
          reason: 'mcp-none-configured',
          message: i18n.t('common:coworkReadiness.mcpNone'),
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
          message: i18n.t('common:coworkReadiness.localReady'),
          retryable: false,
          capabilities: [],
        })
      : at(now, {
          component: 'local-runtime',
          state: 'blocked',
          reason: 'local-runtime-absent',
          message: i18n.t('common:coworkReadiness.localAbsent'),
          retryable: false,
          capabilities: [],
        })
  )

  return reports
}
