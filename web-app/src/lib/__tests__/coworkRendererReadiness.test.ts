import { describe, expect, it } from 'vitest'
import { rendererReadinessReports } from '@/lib/coworkRendererReadiness'

const byComponent = (facts: Parameters<typeof rendererReadinessReports>[0]) =>
  Object.fromEntries(
    rendererReadinessReports(facts, 1).map((r) => [r.component, r])
  )

describe('the Environment rows the renderer answers for', () => {
  it('answers all four, none of them still checking', () => {
    const rows = rendererReadinessReports(
      {
        model: { id: 'm', provider: 'openai', supportsTools: true },
        contextTokens: 128_000,
        settingsMcpServers: 0,
      },
      1
    )
    expect(rows.map((r) => r.component).sort()).toEqual(
      ['context', 'local-runtime', 'mcp', 'model'].sort()
    )
    for (const row of rows) {
      expect(row.state).not.toBe('checking')
      expect(row.message).not.toBe('')
      expect(row.checkedAtMs).toBe(1)
    }
  })

  it('reports a missing model and an unknown window with their reasons', () => {
    const rows = byComponent({ model: null, contextTokens: null, settingsMcpServers: 0 })
    expect(rows.model.state).toBe('unavailable')
    expect(rows.model.reason).toBe('model-unselected')
    expect(rows.context.state).toBe('degraded')
    expect(rows.context.reason).toBe('context-unknown')
  })

  it('marks MCP and a remote model’s local runtime as not applicable', () => {
    const rows = byComponent({
      model: { id: 'm', provider: 'anthropic', supportsTools: true },
      contextTokens: 200_000,
      settingsMcpServers: 2,
    })
    expect(rows.mcp.reason).toBe('mcp-none-configured')
    expect(rows.mcp.message).toMatch(/not offered to Cowork/)
    expect(rows['local-runtime'].reason).toBe('local-runtime-absent')
  })

  it('says a local model’s runtime is started on demand', () => {
    const rows = byComponent({
      model: { id: 'q', provider: 'llamacpp', supportsTools: true },
      contextTokens: 8192,
      settingsMcpServers: 0,
    })
    expect(rows['local-runtime'].state).toBe('ready')
  })
})
