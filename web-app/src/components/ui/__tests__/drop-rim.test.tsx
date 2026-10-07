import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DropRim } from '../drop-rim'

describe('DropRim', () => {
  it('renders nothing until a drag is over the composer', () => {
    const { rerender } = render(<DropRim active={false} />)
    expect(screen.queryByTestId('drop-rim')).toBeNull()
    rerender(<DropRim active />)
    expect(screen.getByTestId('drop-rim')).toBeInTheDocument()
    expect(
      screen.getByText(/Release to attach|releaseToAttach/)
    ).toBeInTheDocument()
    rerender(<DropRim active={false} />)
    expect(screen.queryByTestId('drop-rim')).toBeNull()
  })
})
