import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k} ${Object.values(opts).join(' ')}` : k,
  }),
}))

import { CompactionDivider } from '../CompactionDivider'
import { CoworkBudgetNotice } from '../CoworkBudgetNotice'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'

const record = {
  summarizedCount: 12,
  summary: 'The user asked for a refactor; files a.ts and b.ts were read.',
  at: 1,
  reason: 'threshold' as const,
}

describe('CompactionDivider', () => {
  it('names how many messages were summarized and expands to the summary', async () => {
    render(<CompactionDivider record={record} />)
    expect(screen.getByText('common:compaction.divider 12')).toBeInTheDocument()
    expect(screen.queryByTestId('compaction-summary')).toBeNull()
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('compaction-summary')).toHaveTextContent(
      'files a.ts and b.ts were read'
    )
  })

  it('is a transcript row of its own in Cowork, never sent as text', () => {
    const messages = coworkTurnsToUIMessages(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', compaction: record },
        { role: 'assistant', content: 'carrying on' },
      ],
      's'
    )
    expect(messages).toHaveLength(3)
    expect(messages[1].parts).toEqual([{ type: 'data-compaction', data: record }])
  })
})

describe('CoworkBudgetNotice compact button', () => {
  it('waits while a compaction is under way', () => {
    render(
      <CoworkBudgetNotice
        kind="tokens"
        cause="window"
        onCompact={() => {}}
        compacting
        onNewSession={() => {}}
      />
    )
    const button = screen.getByText('common:budget.compacting').closest('button')
    expect(button).toBeDisabled()
  })
})
