import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => (o?.count != null ? `${k} ${o.count}` : k),
  }),
}))

import { CoworkBarStack } from '../CoworkBarStack'

const Bar = ({ id }: { id: string }) => <div data-testid={id}>{id}</div>
// Renders nothing, as a PR bar with no PR does.
const Empty = () => null

const visible = (id: string) => !screen.getByTestId(id).parentElement!.hidden

describe('CoworkBarStack', () => {
  it('shows the first two bars with content and folds the rest', () => {
    render(
      <CoworkBarStack>
        <Empty />
        <Bar id="a" />
        <Bar id="b" />
        {false && <Bar id="never" />}
        <Bar id="c" />
        <Bar id="d" />
      </CoworkBarStack>
    )
    expect(visible('a')).toBe(true)
    expect(visible('b')).toBe(true)
    expect(visible('c')).toBe(false)
    expect(visible('d')).toBe(false)
    const toggle = screen.getByTestId('cowork-bar-stack-toggle')
    expect(toggle).toHaveTextContent('common:coworkBars.showMore 2')

    fireEvent.click(toggle)
    expect(visible('c')).toBe(true)
    expect(visible('d')).toBe(true)
    expect(toggle).toHaveTextContent('common:coworkBars.showFewer')
  })

  it('has no chip when everything fits', () => {
    render(
      <CoworkBarStack>
        <Bar id="a" />
        <Empty />
        <Bar id="b" />
      </CoworkBarStack>
    )
    expect(screen.queryByTestId('cowork-bar-stack-toggle')).toBeNull()
    expect(visible('b')).toBe(true)
  })
})
