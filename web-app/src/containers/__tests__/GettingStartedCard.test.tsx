import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// State-backed: real guide, provider and thread stores; navigation is a spy.
// Keys render as-is because no TranslationProvider is mounted.

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { GettingStartedCard } from '../GettingStartedCard'
import { useOnboardingGuide } from '@/hooks/useOnboardingGuide'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'
import { INITIAL_GUIDE_STATE } from '@/lib/onboarding'

const localProvider = {
  provider: 'llamacpp',
  active: true,
  models: [{ id: 'qwen3-8b', capabilities: [] }],
  settings: [],
} as unknown as ModelProvider

const thread = (id: string, updated: number) =>
  ({ id, title: `Thread ${id}`, updated }) as unknown as Thread

describe('GettingStartedCard', () => {
  beforeEach(() => {
    navigate.mockReset()
    useOnboardingGuide.setState({ ...INITIAL_GUIDE_STATE })
    useModelProvider.setState({ providers: [localProvider] })
    useThreads.setState({ threads: {} })
  })

  it('shows nothing to a first-time user who skipped the guide and has no conversations', () => {
    useOnboardingGuide.setState({ status: 'skipped' })
    const { container } = render(<GettingStartedCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('offers a returning user their most recent conversation, without the guide', () => {
    useThreads.setState({ threads: { a: thread('a', 1), b: thread('b', 5) } })
    render(<GettingStartedCard />)
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'onboarding:resumeRecent' }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/threads/$threadId',
      params: { threadId: 'b' },
    })
  })

  it('marks observed steps from real state and only confirmed steps from the user', () => {
    useOnboardingGuide.getState().start('documents', 0)
    render(<GettingStartedCard />)
    const region = screen.getByRole('region', { name: 'onboarding:guideRegion' })
    // A usable local model exists, so choosing a model is done; the first
    // task is not, and has no self-confirm button.
    expect(region).toHaveTextContent('onboarding:stepDone')
    expect(screen.getAllByRole('button', { name: 'onboarding:confirmStep' })).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'onboarding:confirmStep' })[0])
    expect(useOnboardingGuide.getState().confirmedSteps).toEqual(['add-material'])
  })

  it('points to the sidebar settings and opens them on that group', () => {
    useOnboardingGuide.getState().start('question', 0)
    render(<GettingStartedCard />)
    expect(screen.getByTestId('guide-sidebar-note')).toHaveTextContent(
      'onboarding:sidebar.title'
    )
    fireEvent.click(screen.getByTestId('guide-customize-sidebar'))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/interface' })
    expect(useSettingsSearch.getState().pendingTarget).toBe(
      'settings-appearance-sidebar-items'
    )
  })

  it('completes when every step is done, and can be hidden at any time', () => {
    useOnboardingGuide.getState().start('question', 0)
    useThreads.setState({ threads: { a: thread('a', 1) } })
    render(<GettingStartedCard />)
    expect(screen.getByRole('status')).toHaveTextContent('onboarding:guideComplete')
    fireEvent.click(screen.getByRole('button', { name: 'onboarding:finish' }))
    expect(useOnboardingGuide.getState().status).toBe('completed')
  })

  it('ticks the home checklist from real state: model yes, chat and project no', () => {
    useOnboardingGuide.getState().start('question', 0)
    render(<GettingStartedCard />)
    const items = screen
      .getByTestId('guide-checklist')
      .querySelectorAll('li')
    expect([...items].map((li) => li.hasAttribute('data-done'))).toEqual([
      true,
      false,
      false,
    ])
  })

  it('offers a sample question that fills the message box and never sends', async () => {
    const { usePrompt } = await import('@/hooks/usePrompt')
    usePrompt.getState().setPrompt('')
    useOnboardingGuide.getState().start('question', 0)
    render(<GettingStartedCard />)
    fireEvent.click(screen.getByTestId('guide-sample-question'))
    expect(usePrompt.getState().prompt).toBe('onboarding:sample.question')
    expect(useThreads.getState().threads).toEqual({})
  })

  it('does not overwrite what the user already typed', async () => {
    const { usePrompt } = await import('@/hooks/usePrompt')
    usePrompt.getState().setPrompt('my own draft')
    useOnboardingGuide.getState().start('question', 0)
    render(<GettingStartedCard />)
    fireEvent.click(screen.getByTestId('guide-sample-question'))
    expect(usePrompt.getState().prompt).toBe('my own draft')
  })

  it('explains where approvals appear only for project work', () => {
    useOnboardingGuide.getState().start('project', 0)
    const { unmount } = render(<GettingStartedCard />)
    expect(screen.getByTestId('guide-approvals-note')).toHaveTextContent(
      'onboarding:approvalsNote'
    )
    unmount()
    useOnboardingGuide.getState().start('question', 0)
    render(<GettingStartedCard />)
    expect(screen.queryByTestId('guide-approvals-note')).not.toBeInTheDocument()
  })

  it('hides the guide without changing anything else', () => {
    useOnboardingGuide.getState().start('project', 0)
    render(<GettingStartedCard />)
    fireEvent.click(screen.getByRole('button', { name: 'onboarding:hideGuide' }))
    expect(useOnboardingGuide.getState().status).toBe('skipped')
    expect(useModelProvider.getState().providers).toEqual([localProvider])
  })
})
