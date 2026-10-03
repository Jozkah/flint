import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.tool ? `${key}:${options.tool}` : key,
  }),
}))

vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: (selector: (s: unknown) => unknown) =>
    selector({ pending: {} }),
  usePendingApprovalCount: () => 0,
}))

const origin = vi.fn()
vi.mock('@/hooks/useToolOrigin', () => ({
  useToolOrigin: () => origin(),
}))

vi.mock('../WebToolWidget', () => ({
  WebToolWidget: ({ bar }: { bar: { query?: string } }) => (
    <div data-testid="web-widget">{bar.query}</div>
  ),
}))

vi.mock('../RagToolWidget', () => ({
  RagToolWidget: () => <div data-testid="rag-widget" />,
}))

import { ToolCallCard } from '../ToolCallCard'

describe('ToolCallCard', () => {
  // A native call's header names the one argument it is about -- the query --
  // rather than a generic `key: value` preview; the widget shows the result.
  it('names the query in the header and leaves the result to the widget', () => {
    origin.mockReturnValue({ kind: 'web-search', detail: 'Exa' })
    render(
      <ToolCallCard
        part={{
          type: 'tool-web_search',
          state: 'output-error',
          toolCallId: 'tc1',
          input: { query: 'deepfake prevention news' },
          errorText: 'rate limited',
        }}
        messageId="m1"
      />
    )
    expect(screen.getByTestId('web-widget')).toBeInTheDocument()
    expect(
      screen.queryByText('query: deepfake prevention news')
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByText('deepfake prevention news').length
    ).toBeGreaterThan(0)
  })

  // Without a widget the header preview is the only thing describing the call
  // while it is collapsed.
  it('previews the arguments in the header for a tool with no widget', () => {
    origin.mockReturnValue({ kind: 'mcp', detail: 'github' })
    render(
      <ToolCallCard
        part={{
          type: 'tool-create_issue',
          state: 'output-available',
          toolCallId: 'tc2',
          input: { title: 'Bug' },
          output: 'done',
        }}
        messageId="m1"
      />
    )
    expect(screen.getByText('title: Bug')).toBeInTheDocument()
  })

  // A command that ran and exited non-zero is a failed check: amber, not the
  // red a refusal, crash or timeout gets.
  it('colours a non-zero exit amber and a failed call red', () => {
    origin.mockReturnValue({ kind: 'agent' })
    const { container, unmount } = render(
      <ToolCallCard
        part={{
          type: 'tool-bash',
          state: 'output-available',
          toolCallId: 'tc-exit',
          input: { command: 'pytest' },
          output: '2 failed\n[exit 1]',
        }}
        messageId="m1"
      />
    )
    expect(
      container.querySelector('[data-slot="tool-card"]')
    ).toHaveAttribute('data-tool-kind', 'warn')
    unmount()
    const failed = render(
      <ToolCallCard
        part={{
          type: 'tool-bash',
          state: 'output-error',
          toolCallId: 'tc-err',
          input: { command: 'pytest' },
          errorText: 'refused',
        }}
        messageId="m1"
      />
    )
    expect(
      failed.container.querySelector('[data-slot="tool-card"]')
    ).toHaveAttribute('data-tool-kind', 'fail')
  })

  // A chat `read` of an image file: the model got the image, and the card shows
  // it as a thumbnail with the result text, not the base64 as JSON.
  it('shows a thumbnail for an image a tool returned', () => {
    origin.mockReturnValue(undefined)
    render(
      <ToolCallCard
        part={{
          type: 'tool-read',
          state: 'output-available',
          toolCallId: 'tc9',
          input: { path: 'shot.png' },
          output: [
            { type: 'text', text: 'Read image shot.png (image/png, 3 bytes)' },
            {
              type: 'image',
              data: 'data:image/png;base64,QUJD',
              mimeType: 'image/png',
              name: 'shot.png',
            },
          ],
        }}
        messageId="m1"
        expanded
      />
    )
    const img = screen.getByAltText('shot.png') as HTMLImageElement
    expect(img.src).toContain('data:image/png;base64,QUJD')
    expect(document.body.textContent).not.toContain('QUJD')
  })
})
