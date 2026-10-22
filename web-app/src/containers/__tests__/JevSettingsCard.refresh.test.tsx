import { describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const status = vi.fn(async () => ({
  skill_mode: 'off',
  rerank_mode: 'off',
  key_configured: false,
  model: 'jev',
  tokens_used_today: 0,
  daily_token_budget: 1,
}))
const receipts = vi.fn(async () => [])

vi.mock('@/lib/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/jev')>()),
  jevStatus: () => status(),
  jevReceipts: () => receipts(),
}))

import { JevSettingsCard } from '../JevSettingsCard'

describe('JevSettingsCard default api', () => {
  it('asks for status once, not on every re-render', async () => {
    render(<JevSettingsCard />)
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(status).toHaveBeenCalledTimes(1)
    expect(receipts).toHaveBeenCalledTimes(1)
  })
})
