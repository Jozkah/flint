import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

import { ComposerDensityProvider } from '../ComposerDensity'
import { CoworkRunSettings } from '../CoworkRunSettings'
import { CoworkWorkspacePill } from '../CoworkWorkspacePill'

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
}))

const row = (width: number) =>
  render(
    <ComposerDensityProvider width={width}>
      <CoworkRunSettings exceptions={[]}>x</CoworkRunSettings>
      <CoworkWorkspacePill
        folder="/work/flint"
        workspacePath={null}
        gitBranch="feat/very-long-branch"
        onAttach={() => undefined}
        onDetach={() => undefined}
      />
    </ComposerDensityProvider>
  )

describe('composer controls at a container width', () => {
  it('shows every label when wide', () => {
    row(900)
    const run = screen.getByTestId('cowork-run-settings')
    expect(run).toHaveTextContent('Run settings')
    expect(run).not.toHaveAttribute('data-collapsed')
    const chip = screen.getByRole('button', { name: /flint/i })
    expect(chip).toHaveTextContent('flint')
    // The branch is in the name's tooltip, not printed beside it (one quiet chip).
    expect(chip).not.toHaveTextContent('feat/very-long-branch')
    expect(chip.querySelector('[data-folder-name]')).toHaveAttribute(
      'title',
      'flint · feat/very-long-branch'
    )
  })

  it('drops the Run settings text first, keeping its accessible name and a tooltip', () => {
    row(600)
    const run = screen.getByTestId('cowork-run-settings')
    expect(run).not.toHaveTextContent('Run settings')
    expect(run).toHaveAccessibleName('Run settings')
    expect(run).toHaveAttribute('title', 'Run settings')
    expect(screen.getByRole('button', { name: /flint/i })).toHaveTextContent('flint')
  })

  it('keeps the folder name, then shows the icon alone', () => {
    const { unmount } = row(500)
    let chip = screen.getByRole('button', { name: /flint/i })
    expect(chip).toHaveTextContent('flint')
    unmount()
    row(300)
    chip = screen.getByRole('button', { name: /flint/i })
    expect(chip).toHaveTextContent('')
    expect(chip).toHaveAttribute('title', 'flint')
  })
})
