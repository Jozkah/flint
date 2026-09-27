import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.skill ? `${k}:${o.skill}` : k) }),
}))

import { JevSkillSuggestion, SUGGEST_DEBOUNCE_MS } from '../JevSkillSuggestion'
import { JevSettingsCard } from '../JevSettingsCard'
import { useJevSettings } from '@/hooks/useJevSettings'
import { usePrompt } from '@/hooks/usePrompt'
import type { SlashCatalogEntry } from '@/lib/slashCommands'

const catalog: SlashCatalogEntry[] = [
  { kind: 'skill', name: 'pdf-forms', description: 'Fill PDF forms', scope: 'global' },
  { kind: 'command', name: 'deploy', description: 'Run deploy', scope: 'project', body: 'x' },
]
const TEXT = 'please fill in the vendor onboarding PDF'

async function type(text: string) {
  act(() => usePrompt.getState().setPrompt(text))
  await act(async () => {
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS + 10)
  })
  await act(async () => {})
}

describe('JevSkillSuggestion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    usePrompt.getState().setPrompt('')
  })
  afterEach(() => vi.useRealTimers())

  it('off: asks nothing and loads nothing', async () => {
    useJevSettings.setState({ skillMode: 'off' })
    const suggest = vi.fn()
    const loadCatalog = vi.fn(async () => catalog)
    render(<JevSkillSuggestion surface="cowork" suggest={suggest} loadCatalog={loadCatalog} />)
    await type(TEXT)
    expect(loadCatalog).not.toHaveBeenCalled()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('on: offers only a catalog skill, and Use writes the same /skill command', async () => {
    useJevSettings.setState({ skillMode: 'on' })
    const suggest = vi.fn(async () => ({ skill: 'pdf-forms', probability: 0.9, fallback: null, model: 'jev-1.13.0' }))
    render(<JevSkillSuggestion surface="cowork" suggest={suggest} loadCatalog={async () => catalog} />)
    await type(TEXT)
    expect(suggest).toHaveBeenCalledWith(TEXT, [{ name: 'pdf-forms', description: 'Fill PDF forms' }])
    expect(screen.getByTestId('jev-skill-suggestion').textContent).toContain('pdf-forms')
    fireEvent.click(screen.getByTestId('jev-skill-use'))
    expect(usePrompt.getState().prompt).toBe(`/pdf-forms ${TEXT}`)
  })

  it('shows nothing on abstention, a fallback, or a message that is already a command', async () => {
    useJevSettings.setState({ skillMode: 'on' })
    const suggest = vi.fn(async () => ({ skill: null, probability: 0.4, fallback: 'abstained' as const, model: 'jev-1.13.0' }))
    render(<JevSkillSuggestion surface="cowork" suggest={suggest} loadCatalog={async () => catalog} />)
    await type(TEXT)
    expect(screen.queryByTestId('jev-skill-suggestion')).toBeNull()
    suggest.mockClear()
    await type('/pdf-forms fill in the vendor onboarding PDF')
    expect(suggest).not.toHaveBeenCalled()
  })

  it('shadow: the backend is asked, but nothing is shown', async () => {
    useJevSettings.setState({ skillMode: 'shadow' })
    const suggest = vi.fn(async () => ({ skill: null, probability: 0.9, fallback: 'shadow' as const, model: 'jev-1.13.0' }))
    render(<JevSkillSuggestion surface="cowork" suggest={suggest} loadCatalog={async () => catalog} />)
    await type(TEXT)
    expect(suggest).toHaveBeenCalled()
    expect(screen.queryByTestId('jev-skill-suggestion')).toBeNull()
  })
})

describe('JevSettingsCard', () => {
  it('both opt-ins default to off, and the key is write-only', async () => {
    useJevSettings.setState({ skillMode: 'off', rerankMode: 'off' })
    const api = {
      jevStatus: vi.fn(async () => ({
        skill_mode: 'off' as const,
        rerank_mode: 'off' as const,
        key_configured: false,
        model: 'jev-1.13.0',
        tokens_used_today: 0,
        daily_token_budget: 2_000_000,
      })),
      jevReceipts: vi.fn(async () => []),
      jevSetKey: vi.fn(async () => undefined),
      jevClearKey: vi.fn(async () => undefined),
    }
    render(<JevSettingsCard api={api} />)
    await act(async () => {})
    for (const id of ['jev-skill-mode', 'jev-rerank-mode']) {
      const checked = screen.getByTestId(id).querySelector('[aria-checked="true"]')
      expect(checked?.getAttribute('data-mode')).toBe('off')
    }
    const input = screen.getByTestId('jev-key-input') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'ts_live_abc' } })
    fireEvent.click(screen.getByText('common:jev.saveKey'))
    await act(async () => {})
    expect(api.jevSetKey).toHaveBeenCalledWith('ts_live_abc')
    expect(input.value).toBe('')
    // Turning one on leaves the other off.
    fireEvent.click(screen.getByTestId('jev-rerank-mode').querySelector('[data-mode="shadow"]')!)
    expect(useJevSettings.getState()).toMatchObject({ skillMode: 'off', rerankMode: 'shadow' })
  })
})
