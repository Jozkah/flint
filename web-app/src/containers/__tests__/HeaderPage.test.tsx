import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import HeaderPage from '../HeaderPage'
import { HeaderSlotProvider, useHeaderSlot } from '@/components/shell/HeaderSlot'

function Slot() {
  const ctx = useHeaderSlot()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ctx?.setSlot(ref.current)
  }, [ctx])
  return <div data-testid="slot" ref={ref} />
}

describe('HeaderPage', () => {
  it('renders in place outside the shell', () => {
    render(
      <HeaderPage>
        <span>Page actions</span>
      </HeaderPage>
    )
    expect(screen.getByText('Page actions')).toBeInTheDocument()
    expect(screen.getByTestId('page-header')).toBeInTheDocument()
  })

  it('moves its controls into the shell header slot', () => {
    render(
      <HeaderSlotProvider>
        <Slot />
        <main data-testid="page">
          <HeaderPage>
            <button>Save</button>
          </HeaderPage>
        </main>
      </HeaderSlotProvider>
    )
    const slot = screen.getByTestId('slot')
    expect(slot).toContainElement(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByTestId('page')).not.toContainElement(
      screen.getByRole('button', { name: 'Save' })
    )
  })

  it('renders nothing without children', () => {
    const { container } = render(<HeaderPage />)
    expect(container).toBeEmptyDOMElement()
  })
})
