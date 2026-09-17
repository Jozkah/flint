import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WebPreviewPip } from '../WebPreviewPip'

describe('WebPreviewPip', () => {
  it('renders a fixed container with drag and resize handles and children', () => {
    render(
      <WebPreviewPip title="Preview">
        <div>body</div>
      </WebPreviewPip>
    )
    expect(screen.getByTestId('pip-drag')).toBeInTheDocument()
    expect(screen.getByTestId('pip-resize')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
    const root = screen.getByTestId('web-preview-pip')
    expect(getComputedStyle(root).position).toBe('fixed')
  })
})
