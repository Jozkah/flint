import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SettingsPageBody } from '../SettingsPageHeader'
import { packColumns } from '../SettingsBalancedColumns'

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

  it('keeps the groups in source (tab) order in the DOM', () => {
    render(
      <SettingsPageBody testId="body" layout={[1, 0, 1, 0]}>
        {group('a')}
        {group('b')}
        {group('c')}
        {group('d')}
      </SettingsPageBody>
    )
    const row = screen.getByTestId('body').firstElementChild!.children[0]
    expect([...row.children].map((c) => c.textContent)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('packColumns', () => {
  const ends = (heights: number[]) => {
    const e = [0, 0]
    packColumns(heights).forEach((p, i) => {
      e[p.col] = Math.max(e[p.col], p.top + heights[i])
    })
    return e
  }

  it('puts each group in the shorter column so far', () => {
    expect(packColumns([100, 300, 100, 100]).map((p) => p.col)).toEqual([0, 1, 0, 0])
  })

  it('stacks groups of one column with a gap and no overlap', () => {
    const p = packColumns([100, 300, 100])
    expect(p[2].top).toBe(p[0].top + 100 + 16)
  })

  it('ends the columns within one group of each other', () => {
    // The Memory page: two big groups and two small ones.
    const [a, b] = ends([439, 784, 240, 236])
    expect(Math.abs(a - b)).toBeLessThanOrEqual(240)
  })

  it('gives a group that renders nothing no gap', () => {
    const p = packColumns([100, 0, 100])
    expect(p[2].col).toBe(1)
  })
})
