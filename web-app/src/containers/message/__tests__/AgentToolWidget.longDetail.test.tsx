import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

describe('AgentToolWidget trailing detail (#295)', () => {
  // A find/grep card shows its search root after the pattern. A managed
  // worktree root is a long absolute path; before the fix it rendered in a
  // `shrink-0` span with no truncation and scrolled the transcript sideways.
  const longPath = [
    'C:',
    'tmp',
    'flint-10-task-smoke',
    'profile-tasks',
    'data',
    'agent-workspace',
    'worktrees',
    '7420aec28ee8701c',
    '645170f1dfc6-e7798d2130556fcf',
    'a'.repeat(80),
  ].join('\\')

  it.each(['find', 'grep'])(
    'lets a long %s path shrink and truncate, with the full value on hover',
    (tool) => {
      render(
        <AgentToolWidget
          bar={{
            variant: 'workspace',
            tool,
            target: '**/*.test.ts',
            detail: longPath,
          }}
          state="output-available"
        />
      )
      const detail = screen.getByTestId('tool-bar-detail')
      expect(detail).toHaveTextContent(longPath)
      expect(detail).toHaveAttribute('title', longPath)
      expect(detail).toHaveClass('min-w-0', 'truncate')
      expect(detail).not.toHaveClass('shrink-0')
    }
  )
})
