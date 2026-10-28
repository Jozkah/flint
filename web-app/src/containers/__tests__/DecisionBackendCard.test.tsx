import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, string>) => (o ? `${k} ${JSON.stringify(o)}` : k),
  }),
}))

const mocks = vi.hoisted(() => ({
  providers: [
    {
      provider: 'llamacpp',
      active: true,
      models: [{ id: 'Kev-4B-Q4_K_M' }],
    },
    {
      provider: 'qwen-service',
      active: true,
      base_url: 'https://qwen.example.com/v1',
      models: [{ id: 'qwen3-4b' }],
    },
  ],
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: { providers: unknown[] }) => unknown) => sel({ providers: mocks.providers }),
}))

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  isLocalProvider: (p: string) => p === 'llamacpp',
}))

vi.mock('@/containers/McpRouterModelPicker', () => ({
  McpRouterModelPicker: (p: { onSelect: (a: string, b: string) => void; selectedModelId: string }) => (
    <button data-testid="picker" onClick={() => p.onSelect('qwen-service', 'qwen3-4b')}>
      {p.selectedModelId || 'none'}
    </button>
  ),
}))

import { DecisionBackendCard } from '../DecisionBackendCard'
import { useJevSettings } from '@/hooks/useJevSettings'
import { DECISION_PRESETS, findPresetModel, normalizeBackend } from '@/lib/decisionBackends'

describe('DecisionBackendCard', () => {
  beforeEach(() => {
    useJevSettings.setState({ backend: { kind: 'jev' } })
  })

  it('defaults to Jev and shows no model picker', () => {
    render(<DecisionBackendCard />)
    expect(screen.queryByTestId('picker')).toBeNull()
    expect(useJevSettings.getState().backend).toEqual({ kind: 'jev' })
  })

  it('switching to an open model asks for a model; Jev is used until one is chosen', () => {
    render(<DecisionBackendCard />)
    fireEvent.click(screen.getByTestId('jev-backend-open'))
    expect(useJevSettings.getState().backend).toEqual({ kind: 'open_model', provider: '', model: '' })
    expect(screen.getByTestId('jev-backend-where').textContent).toBe('common:jev.backendNoModel')
  })

  it('a preset picks a matching configured local model and says nothing leaves', () => {
    useJevSettings.setState({ backend: { kind: 'open_model', provider: '', model: '' } })
    render(<DecisionBackendCard />)
    fireEvent.change(screen.getByTestId('jev-backend-preset'), { target: { value: 'kev-4b' } })
    expect(useJevSettings.getState().backend).toEqual({
      kind: 'open_model',
      provider: 'llamacpp',
      model: 'Kev-4B-Q4_K_M',
      preset: 'kev-4b',
    })
    expect(screen.getByTestId('jev-backend-where').textContent).toBe('common:jev.backendLocal')
  })

  it('a remote provider says plainly the text goes to that provider', () => {
    useJevSettings.setState({ backend: { kind: 'open_model', provider: '', model: '' } })
    render(<DecisionBackendCard />)
    fireEvent.click(screen.getByTestId('picker'))
    expect(useJevSettings.getState().backend).toEqual({ kind: 'open_model', provider: 'qwen-service', model: 'qwen3-4b' })
    expect(screen.getByTestId('jev-backend-where').textContent).toContain('common:jev.backendRemote')
    expect(screen.getByTestId('jev-backend-where').textContent).toContain('qwen-service')
  })

  it('a preset with no configured model keeps asking, never guesses an endpoint', () => {
    useJevSettings.setState({ backend: { kind: 'open_model', provider: '', model: '' } })
    render(<DecisionBackendCard />)
    fireEvent.change(screen.getByTestId('jev-backend-preset'), { target: { value: 'laya' } })
    expect(useJevSettings.getState().backend).toEqual({ kind: 'open_model', provider: '', model: '', preset: 'laya' })
  })
})

describe('decisionBackends', () => {
  it('lists the typed-decision presets', () => {
    expect(DECISION_PRESETS.map((p) => p.label)).toEqual([
      'Von',
      'Laya',
      'Kev-0.8B',
      'Kev-4B',
      'Rizzo Flow 4B',
      'Rizzo Flow 1.7B',
      'Our Qwen3-4B service',
    ])
  })

  it('matches presets by squashed id and does not confuse Kev sizes', () => {
    const ps = [{ provider: 'x', models: [{ id: 'kev-0.8b' }, { id: 'rizzo_flow_1.7b' }] }]
    expect(findPresetModel('kev-0.8b', ps)).toEqual({ provider: 'x', model: 'kev-0.8b' })
    expect(findPresetModel('kev-4b', ps)).toBeUndefined()
    expect(findPresetModel('rizzo-flow-1.7b', ps)).toEqual({ provider: 'x', model: 'rizzo_flow_1.7b' })
    expect(findPresetModel('qwen3-4b-service', [{ provider: 'q', models: [{ id: 'Qwen3-4B' }] }])).toEqual({
      provider: 'q',
      model: 'Qwen3-4B',
    })
  })

  it('anything unreadable is Jev', () => {
    expect(normalizeBackend(undefined)).toEqual({ kind: 'jev' })
    expect(normalizeBackend({ kind: 'open_model', provider: 1 })).toEqual({ kind: 'jev' })
    expect(normalizeBackend({ kind: 'open_model', provider: 'a', model: 'b' })).toEqual({
      kind: 'open_model',
      provider: 'a',
      model: 'b',
    })
  })
})
