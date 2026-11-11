import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { FileRow } from '../FileRow'

it('shows a Windows verbatim path without its prefix', () => {
  render(
    <FileRow
      path={'\\\\?\\C:\\work\\notes.md'}
      additions={1}
      deletions={0}
      isExpanded={false}
      onToggle={() => {}}
    >
      {null}
    </FileRow>
  )
  expect(screen.getByText('C:\\work\\notes.md')).toBeTruthy()
  expect(screen.queryByText(/\\\\\?\\/)).toBeNull()
})
