import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = vi.hoisted(() => ({
  compat: null as null | Record<string, any>,
  roots: null as null | Record<string, any>,
  events: null as null | Record<string, any>,
  readiness: null as null | Record<string, any>,
  setEnabled: vi.fn(),
  setSkillRoots: vi.fn(),
  listDir: vi.fn(),
}))

vi.mock('@/containers/CoworkReadinessCard', () => ({
  CoworkReadinessCard: (p: Record<string, any>) => {
    m.readiness = p
    return <div data-testid="readiness">{p.modelTest}</div>
  },
}))
vi.mock('@/containers/ModelDoctor', () => ({ ModelDoctor: () => <i data-testid="doctor" /> }))
vi.mock('@/containers/SessionMessagingToggle', () => ({ SessionMessagingToggle: () => <i data-testid="messaging" /> }))
vi.mock('@/containers/CoworkEventExport', () => ({
  CoworkEventExport: (p: Record<string, any>) => {
    m.events = p
    return null
  },
}))
vi.mock('@/containers/CoworkEnvironmentReadiness', () => ({ CoworkEnvironmentReadiness: () => null }))
vi.mock('@/containers/CoworkContextBreakdown', () => ({ CoworkContextBreakdown: () => <i data-testid="breakdown" /> }))
vi.mock('@/containers/CoworkCompatSection', () => ({
  CoworkCompatSection: (p: Record<string, any>) => {
    m.compat = p
    return null
  },
}))
vi.mock('@/containers/ClaudeSkillRootsSettings', () => ({
  ClaudeSkillRootsSettings: (p: Record<string, any>) => {
    m.roots = p
    return null
  },
}))
vi.mock('@/hooks/useClaudeCompat', () => ({
  useClaudeCompat: { getState: () => ({ setEnabled: m.setEnabled, setSkillRoots: m.setSkillRoots }) },
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({ projectListDir: (...a: unknown[]) => m.listDir(...a) }))

import { CoworkDetailsBody } from '../CoworkDetailsBody'

const props = (over: Record<string, unknown> = {}) =>
  ({
    readiness: {},
    settingsMcpServers: 2,
    selectedProvider: 'openai',
    getProviderByName: vi.fn(() => ({ provider: 'openai' })),
    selectedModel: { id: 'm' },
    session: { id: 's1' },
    serviceHub: { dialog: () => ({ open: vi.fn(async () => '/picked') }) },
    folder: '/proj',
    rendererReports: [],
    runContext: null,
    compat: { enabled: true },
    mcpProbes: [{ name: 'srv' }],
    setMcpConsent: vi.fn(async () => {}),
    skillRoots: ['/a'],
    janDataFolder: '/data',
    rescanCompat: vi.fn(),
    ...over,
  }) as never

describe('CoworkDetailsBody', () => {
  beforeEach(() => {
    for (const k of ['compat', 'roots', 'events', 'readiness'] as const) m[k] = null
    m.setEnabled.mockClear()
    m.setSkillRoots.mockClear()
    m.listDir.mockReset()
  })

  it('shows the model test and the session toggles only with a session', () => {
    const { unmount } = render(<CoworkDetailsBody {...(props() as any)} />)
    expect(screen.getByTestId('doctor')).toBeTruthy()
    expect(screen.getByTestId('messaging')).toBeTruthy()
    expect(m.readiness?.settingsMcpServers).toBe(2)
    unmount()
    render(<CoworkDetailsBody {...(props({ session: null }) as any)} />)
    expect(screen.queryByTestId('messaging')).toBeNull()
    expect(m.events?.sessionId).toBeUndefined()
  })

  it('shows the context breakdown only once a run has produced one', () => {
    const { unmount } = render(<CoworkDetailsBody {...(props() as any)} />)
    expect(screen.queryByTestId('breakdown')).toBeNull()
    unmount()
    render(<CoworkDetailsBody {...(props({ runContext: {} }) as any)} />)
    expect(screen.getByTestId('breakdown')).toBeTruthy()
  })

  it('toggles compatibility for the folder, and only when there is one', () => {
    const { unmount } = render(<CoworkDetailsBody {...(props() as any)} />)
    m.compat?.onToggle(false)
    expect(m.setEnabled).toHaveBeenCalledWith('/proj', false)
    unmount()
    m.setEnabled.mockClear()
    render(<CoworkDetailsBody {...(props({ folder: null }) as any)} />)
    m.compat?.onToggle(true)
    expect(m.setEnabled).not.toHaveBeenCalled()
  })

  it('grants MCP consent against the probe of the same name only', () => {
    const p: any = props()
    render(<CoworkDetailsBody {...p} />)
    m.compat?.onMcpConsent('srv', true)
    expect(p.setMcpConsent).toHaveBeenCalledWith({ name: 'srv' }, true)
    m.compat?.onMcpConsent('other', true)
    expect(p.setMcpConsent).toHaveBeenCalledTimes(1)
  })

  it('confirms a skill-root directory through the backend, and refuses without a data folder', async () => {
    m.listDir.mockResolvedValue([])
    const { unmount } = render(<CoworkDetailsBody {...(props() as any)} />)
    expect(await m.roots?.confirmDirectory('/x')).toBe(true)
    expect(m.listDir).toHaveBeenCalledWith('/data', '/x', '.')
    m.listDir.mockRejectedValue(new Error('gone'))
    expect(await m.roots?.confirmDirectory('/gone')).toBe(false)
    unmount()
    render(<CoworkDetailsBody {...(props({ janDataFolder: null }) as any)} />)
    expect(await m.roots?.confirmDirectory('/x')).toBe(false)
  })

  it('writes skill roots through the compat store and picks folders through the hub', async () => {
    render(<CoworkDetailsBody {...(props() as any)} />)
    m.roots?.onChange(['/b'])
    expect(m.setSkillRoots).toHaveBeenCalledWith(['/b'])
    expect(await m.roots?.pickFolder()).toBe('/picked')
    expect(await m.events?.pickFolder()).toBe('/picked')
  })
})
