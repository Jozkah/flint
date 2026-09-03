import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="shimmer">{children}</span>
  ),
}))

vi.mock('@/hooks/useToolCallRuntime', () => ({
  useToolCallRuntime: () => undefined,
}))

import { AgentToolWidget } from '../AgentToolWidget'
import { CodeOpenProvider } from '../CodeOpenProvider'

const bar = (tool: string, target: string) =>
  ({ variant: 'workspace', tool, target }) as const

const renderWidget = (
  tool: string,
  target: string,
  open: ((path: string) => void) | null,
  state: 'output-available' | 'input-streaming' = 'output-available'
) => {
  const widget = <AgentToolWidget bar={bar(tool, target)} state={state} />
  return render(
    open ? <CodeOpenProvider open={open}>{widget}</CodeOpenProvider> : widget
  )
}

describe('AgentToolWidget path opening', () => {
  // The spec asks for recognizable file references in tool results to be
  // clickable, "where it can be done without unreliable parsing". A tool
  // call's `path` argument is structured data, so this reads it rather than
  // hunting for path-shaped text in the model's prose.

  it('opens the path a file tool acted on', async () => {
    const open = vi.fn()
    renderWidget('read', 'src/main.rs', open)

    await userEvent.click(screen.getByText('src/main.rs'))
    expect(open).toHaveBeenCalledWith('src/main.rs')
  })

  it.each(['read', 'write', 'edit'])('is offered for %s', (tool) => {
    renderWidget(tool, 'src/a.ts', vi.fn())
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it.each(['find', 'grep'])(
    'is not offered for %s, whose target is a pattern',
    (tool) => {
      // `find`'s target is the glob, not a file — linking it would open
      // something the user never pointed at, if it opened anything at all.
      renderWidget(tool, '**/*.ts', vi.fn())
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(screen.getByText('**/*.ts')).toBeInTheDocument()
    }
  )

  it.each(['ls', 'memory_read', 'skill_read'])(
    'is not offered for %s',
    (tool) => {
      renderWidget(tool, 'notes', vi.fn())
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  )

  it('is inert on a surface with no code panel', () => {
    // Chat renders the same widget and has nowhere to open a file, so it
    // provides no opener and the bar stays plain text.
    renderWidget('read', 'src/main.rs', null)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('src/main.rs')).toBeInTheDocument()
  })

  it('waits for the path to finish streaming', () => {
    // Half an argument names a different file, or none.
    renderWidget('read', 'src/ma', vi.fn(), 'input-streaming')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers nothing when the tool had no path at all', () => {
    renderWidget('read', '', vi.fn())
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
