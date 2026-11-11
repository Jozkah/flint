import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentEntryRow, entryMatches } from '../settings/AgentEntryRow'

describe('entryMatches', () => {
  it('matches an empty query, the name or the description', () => {
    expect(entryMatches('', 'Deploy')).toBe(true)
    expect(entryMatches('dep', 'Deploy')).toBe(true)
    expect(entryMatches('ship', 'Deploy', 'Ships it')).toBe(true)
    expect(entryMatches('zzz', 'Deploy', 'Ships it')).toBe(false)
  })
})

describe('AgentEntryRow', () => {
  it('offers edit and delete for the user own skill', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    render(<AgentEntryRow name="deploy" onEdit={onEdit} onDelete={onDelete} />)
    fireEvent.click(screen.getByLabelText('common:edit deploy'))
    fireEvent.click(screen.getByLabelText('common:delete deploy'))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('shows what was wrong with a skill front matter, and nothing when it read cleanly', () => {
    const { unmount } = render(
      <AgentEntryRow
        name="deploy"
        description="Ship it"
        warning="Quote values that contain a colon."
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByTestId('skill-warning')).toHaveTextContent('settings:agentTools.skillWarning')
    expect(screen.getByText('Quote values that contain a colon.')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
    unmount()
    render(<AgentEntryRow name="deploy" description="Ship it" onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.queryByTestId('skill-warning')).not.toBeInTheDocument()
  })

  it('shows the plugin name instead of actions for a plugin skill', () => {
    render(
      <AgentEntryRow name="lint" plugin="acme" onEdit={vi.fn()} onDelete={vi.fn()} />
    )
    expect(screen.getByText('acme')).toBeInTheDocument()
    expect(screen.queryByLabelText('common:edit lint')).not.toBeInTheDocument()
  })
})
