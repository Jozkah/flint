import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  ComposerDensityProvider,
  useComposerCollapsed,
} from '../ComposerDensity'
import type { CollapsePart } from '@/lib/composerCollapse'

const PARTS: CollapsePart[] = [
  'runSettingsLabel',
  'folderName',
  'accessLabel',
  'chipText',
]

/** The composer row as the controls see it: a label per part, or its icon. */
function Row() {
  return (
    <div>
      {PARTS.map((p) => (
        <Part key={p} part={p} />
      ))}
    </div>
  )
}
function Part({ part }: { part: CollapsePart }) {
  const collapsed = useComposerCollapsed(part)
  return <span data-testid={part}>{collapsed ? 'icon' : 'label'}</span>
}

const states = (width: number) => {
  render(
    <ComposerDensityProvider width={width}>
      <Row />
    </ComposerDensityProvider>
  )
  return PARTS.map((p) => screen.getByTestId(p).textContent)
}

// The split pane widths seen in the QA screenshots: the row's own width.
describe('composer controls at split-pane widths', () => {
  it.each([
    [620, ['label', 'label', 'label', 'label']],
    [540, ['icon', 'label', 'label', 'label']],
    [460, ['icon', 'icon', 'label', 'label']],
    [380, ['icon', 'icon', 'icon', 'label']],
    [300, ['icon', 'icon', 'icon', 'icon']],
  ])('at %ipx', (width, expected) => {
    expect(states(width)).toEqual(expected)
  })

  it('keeps every label when the width is not known yet', () => {
    expect(states(0)).toEqual(['label', 'label', 'label', 'label'])
  })
})
