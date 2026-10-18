import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => EN[key] ?? key }),
}))
const EN: Record<string, string> = {
  'common:translate.title': 'Translate',
  'common:appRail.library': 'Library',
  'common:appRail.rooms': 'Rooms',
  'common:cowork': 'Cowork',
}
vi.mock('@/hooks/useThreads', () => {
  const state = { threads: {}, getFilteredThreads: () => [] }
  const useThreads = (sel: (s: typeof state) => unknown) => sel(state)
  useThreads.getState = () => state
  return { useThreads }
})
vi.mock('@/lib/messageSearch', () => ({ searchMessages: async () => [] }))

import { SearchDialog } from '../dialogs/SearchDialog'
import { useSettingsSearch } from '@/hooks/useSettingsSearch'

async function type(q: string) {
  render(<SearchDialog open onOpenChange={() => {}} />)
  const input = await screen.findByRole('textbox')
  fireEvent.change(input, { target: { value: q } })
  return input
}

describe('SearchDialog pages and settings', () => {
  beforeEach(() => navigate.mockReset())

  it("'transl' finds Translate and Enter opens it", async () => {
    const input = await type('transl')
    const pages = await screen.findByTestId('search-page-hits')
    expect(pages).toHaveTextContent('Translate')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(navigate).toHaveBeenCalledWith({ to: '/translate' })
  })

  it("'trusted' finds the trusted folders setting and Enter goes to it", async () => {
    const input = await type('trusted')
    const settings = await screen.findByTestId('search-setting-hits')
    expect(settings.textContent?.toLowerCase()).toContain('trusted')
    const spy = vi.spyOn(useSettingsSearch.getState(), 'requestTarget')
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(String(navigate.mock.calls[0][0].to)).toContain('/settings')
    spy.mockRestore()
  })
})
