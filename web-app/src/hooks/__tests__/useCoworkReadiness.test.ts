import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@/lib/agentTools', () => ({
  peekAgentToolSchemas: () => null,
  sandboxEnforces: () => false,
}))

import { useCoworkReadiness, type CoworkReadinessInputs } from '../useCoworkReadiness'

const base = {
  sessionId: 's1',
  messages: [],
  runContext: null,
  mode: 'edit',
  subagentDefs: [],
  workspacePath: '/ws',
  folder: '/proj',
  extraFolders: [],
  destination: 'sandbox',
  worktree: undefined,
  gitBranch: 'main',
  projectInstructions: null,
  compat: { binding: { sessionId: 's1', folder: '/proj' }, enabled: false, components: [] },
  tooling: null,
  webSearchEnabled: false,
  hasTurns: false,
  modelCapabilities: null,
  instructionFiles: [],
  baseline: undefined,
  advertisedToolCount: null,
  connectedMcpServers: [],
  availableSkills: [],
  enabledSkills: [],
  composerPrompt: '',
  selectedModel: { id: 'm1', capabilities: ['tools'] },
} as unknown as CoworkReadinessInputs

describe('useCoworkReadiness', () => {
  it('binds the card to the session and folder and reports the model', () => {
    const { result } = renderHook(() => useCoworkReadiness(base))
    const r = result.current.readiness
    expect(r.binding).toEqual({ sessionId: 's1', folder: '/proj' })
    expect(r.branch).toBe('main')
    expect(r.writeDestination).toBe('sandbox')
    expect(r.worktree).toBeNull()
    expect(r.model).toEqual({ id: 'm1', supportsTools: true })
    expect(r.tools).toEqual({ builtins: null, mcpServers: [] })
  })

  it('states the model as unknown rather than guessing when none is selected', () => {
    const { result } = renderHook(() =>
      useCoworkReadiness({ ...base, selectedModel: null })
    )
    expect(result.current.readiness.model).toEqual({ id: null, supportsTools: null })
  })

  it('shows tooling as loading until the read for this folder arrives', () => {
    const { result, rerender } = renderHook((p: CoworkReadinessInputs) => useCoworkReadiness(p), {
      initialProps: base,
    })
    expect(result.current.readiness.tooling).toEqual({ state: 'loading' })
    rerender({ ...base, tooling: { folder: '/other', loaded: null } } as never)
    expect(result.current.readiness.tooling).toEqual({ state: 'loading' })
  })

  it('has no tooling entry without a folder', () => {
    const { result } = renderHook(() => useCoworkReadiness({ ...base, folder: null }))
    expect(result.current.readiness.tooling).toBeUndefined()
  })

  it('prefers the run context once a run has produced one', () => {
    const ctx = { marker: 'run' } as never
    const { result } = renderHook(() => useCoworkReadiness({ ...base, runContext: ctx }))
    expect(result.current.preRunContext).toBeNull()
    expect(result.current.readiness.context).toBe(ctx)
  })

  it('builds a pre-run context before any run', () => {
    const { result } = renderHook(() => useCoworkReadiness(base))
    expect(result.current.preRunContext).not.toBeNull()
  })
})
