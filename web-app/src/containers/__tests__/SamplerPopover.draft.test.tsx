import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SamplerPopover } from '../SamplerPopover'
import { useDraftSampling } from '@/hooks/useDraftSampling'

const updateAssistant = vi.fn()
const assistant = { id: 'a1', name: 'A', parameters: { temperature: 0.5 } }

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: (sel: (s: unknown) => unknown) =>
    sel({ currentAssistant: assistant, updateAssistant, loading: false }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (sel: (s: unknown) => unknown) => sel({ providers: [] }),
}))
vi.mock('@/lib/providerCaps', () => ({ isPredefinedRemoteProvider: () => false }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null,
}))
vi.mock('@/components/AssistantsMenu', () => ({ AssistantsMenu: () => null }))
vi.mock('@/containers/AvatarEmoji', () => ({ AvatarEmoji: () => null }))
vi.mock('@/containers/ParametersSection', () => ({
  ParametersSection: ({
    params,
    onChange,
  }: {
    params: Record<string, unknown>
    onChange: (k: string, v: unknown) => void
  }) => (
    <div>
      <span data-testid="params">{JSON.stringify(params)}</span>
      <button onClick={() => onChange('seed', 42)}>set-seed</button>
    </div>
  ),
}))

const switcher = (thread?: unknown, updateThread = vi.fn()) => ({
  assistants: [assistant as never],
  currentThread: thread as never,
  selectedAssistantId: 'a1',
  setSelectedAssistantId: vi.fn(),
  updateCurrentThreadAssistant: updateThread,
})

describe('SamplerPopover seed scope', () => {
  beforeEach(() => {
    updateAssistant.mockClear()
    useDraftSampling.setState({ byAssistant: {} })
  })

  it('off-thread: a seed waits in the draft and never edits the assistant', () => {
    render(<SamplerPopover draftOffThread assistantSwitcher={switcher()} />)
    fireEvent.click(screen.getByText('set-seed'))
    expect(updateAssistant).not.toHaveBeenCalled()
    expect(useDraftSampling.getState().byAssistant.a1).toEqual({
      temperature: 0.5,
      seed: 42,
    })
    expect(screen.getByTestId('params').textContent).toContain('"seed":42')
  })

  it('a new chat takes the draft once, then the next one starts clean', () => {
    useDraftSampling.getState().set('a1', { seed: 42 })
    expect(useDraftSampling.getState().take('a1')).toEqual({ seed: 42 })
    expect(useDraftSampling.getState().take('a1')).toBeUndefined()
    render(<SamplerPopover draftOffThread assistantSwitcher={switcher()} />)
    expect(screen.getByTestId('params').textContent).not.toContain('seed')
  })

  it('in a thread: the seed goes to that thread, not the draft or assistant', () => {
    const updateThread = vi.fn()
    const thread = { id: 't1', assistants: [assistant] }
    render(
      <SamplerPopover draftOffThread assistantSwitcher={switcher(thread, updateThread)} />
    )
    fireEvent.click(screen.getByText('set-seed'))
    expect(updateThread).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { temperature: 0.5, seed: 42 } })
    )
    expect(updateAssistant).not.toHaveBeenCalled()
    expect(useDraftSampling.getState().byAssistant.a1).toBeUndefined()
  })
})
