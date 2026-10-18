import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SettingsPageBody } from '../SettingsPageHeader'

const group = (id: string) => <div data-testid={id}>{id}</div>

describe('SettingsPageBody layout', () => {
  it('puts a full-width group (2) alone between two rows of columns', () => {
    render(
      <SettingsPageBody testId="body" layout={[0, 1, 2, 0, 1]}>
        {group('a')}
        {group('b')}
        {group('wide')}
        {group('c')}
        {group('d')}
      </SettingsPageBody>
    )
    const rows = screen.getByTestId('body').firstElementChild!.children
    // columns row, the full-width group, columns row
    expect(rows).toHaveLength(3)
    expect(rows[1]).toContainElement(screen.getByTestId('wide'))
    expect(rows[1].className).not.toContain('grid-cols-2')
    expect(rows[0]).toContainElement(screen.getByTestId('a'))
    expect(rows[0]).toContainElement(screen.getByTestId('b'))
    expect(rows[2]).toContainElement(screen.getByTestId('c'))
    expect(rows[2]).toContainElement(screen.getByTestId('d'))
    expect(rows[0].className).toContain('@min-[44rem]:grid-cols-2')
  })
})
