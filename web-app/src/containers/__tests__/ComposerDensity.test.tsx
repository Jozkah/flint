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
    expect(screen.getByRole('button', { name: /flint/i })).toHaveTextContent('flint')
    expect(screen.getByRole('button', { name: /flint/i })).toHaveTextContent('feat/very-long-branch')
  })

  it('drops the Run settings text first, keeping its accessible name and a tooltip', () => {
    row(600)
    const run = screen.getByTestId('cowork-run-settings')
    expect(run).not.toHaveTextContent('Run settings')
    expect(run).toHaveAccessibleName('Run settings')
    expect(run).toHaveAttribute('title', 'Run settings')
    expect(screen.getByRole('button', { name: /flint/i })).toHaveTextContent('flint')
  })

  it('then shows the branch instead of the folder name, then the icon alone', () => {
    const { unmount } = row(500)
    let chip = screen.getByRole('button', { name: /flint/i })
    expect(chip).not.toHaveTextContent(/^flint/)
    expect(chip).toHaveTextContent('feat/very-long-branch')
    unmount()
    row(300)
    chip = screen.getByRole('button', { name: /flint/i })
    expect(chip).toHaveTextContent('')
    expect(chip).toHaveAttribute('title', 'flint')
  })
})
