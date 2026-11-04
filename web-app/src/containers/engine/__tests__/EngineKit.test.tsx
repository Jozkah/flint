import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => `t(${key})` }),
}))

import { CapabilityChips, TBox, TBOX_ROW } from '../EngineKit'

describe('TBox', () => {
  it('is a table whose header cells are column headers, not hidden from assistive tech', () => {
    render(
      <TBox columns="1fr 1fr" head={['Name', 'Size']}>
        <div role="row" className={TBOX_ROW}>
          <span role="cell">a</span>
          <span role="cell">1</span>
        </div>
      </TBox>
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument()
    expect(screen.getAllByRole('cell')).toHaveLength(2)
  })

  it('without a header is a plain box, so a list inside it keeps its own semantics', () => {
    render(
      <TBox columns="1fr">
        <ul>
          <li>one</li>
        </ul>
      </TBox>
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('list')).toBeInTheDocument()
  })
})

describe('CapabilityChips', () => {
  it('names each chip through i18n, in the label and the title', () => {
    render(<CapabilityChips capabilities={['tools', 'web_search']} />)
    expect(screen.getByText('t(common:capabilityChips.tools)')).toBeInTheDocument()
    expect(screen.getByText('t(common:capabilityChips.web_search)')).toBeInTheDocument()
    expect(screen.getByTitle('t(common:capabilityChips.web_searchTitle)')).toBeInTheDocument()
  })

  it('an icon-only chip carries the translated name as its accessible name', () => {
    render(<CapabilityChips iconOnly capabilities={['vision']} />)
    expect(screen.getByLabelText('t(common:capabilityChips.vision)')).toBeInTheDocument()
  })
})
