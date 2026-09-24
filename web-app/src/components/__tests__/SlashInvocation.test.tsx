import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { SlashInvocation } from '../SlashInvocation'
import { RoomMessageText } from '@/containers/rooms/RoomMessageText'
import { expandCommand } from '@/lib/slashCommands'

describe('SlashInvocation', () => {
  it('shows the typed command and folds the expansion away', () => {
    render(
      <SlashInvocation
        invocation={{ kind: 'command', name: 'git:commit', args: 'wip' }}
        body="EXPANDED BODY"
      />
    )
    expect(screen.getByText('/git:commit wip')).toBeInTheDocument()
    expect(screen.getByText('slash:sent.showCommand')).toBeInTheDocument()
    expect(screen.getByText('EXPANDED BODY').closest('details')).not.toHaveAttribute('open')
  })

  it('renders a room message that carries a command compactly', () => {
    const text = expandCommand(
      { kind: 'command', name: 'debate', plugin: 'kit', description: '', scope: 'global', body: 'Debate $ARGUMENTS' },
      'tabs vs spaces'
    )
    render(<RoomMessageText text={text} mentionColors={new Map()} />)
    expect(screen.getByTestId('slash-invocation')).toHaveTextContent('/kit:debate tabs vs spaces')
  })
})
