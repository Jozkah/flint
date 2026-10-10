import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import {
  UsageCeilingsCard,
  formatWait,
  parseCeiling,
} from '../UsageCeilingsCard'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string; wait?: string }) =>
      (o?.defaultValue ?? k).replace('{{wait}}', o?.wait ?? ''),
  }),
}))

describe('formatWait', () => {
  it('reads seconds, minutes, hours and days', () => {
    expect(formatWait(50)).toBe('50s')
    expect(formatWait(35 * 60)).toBe('35m')
    expect(formatWait(4 * 3600 + 12 * 60)).toBe('4h 12m')
    expect(formatWait(2 * 86400 + 3 * 3600)).toBe('2d 3h')
  })
})

describe('parseCeiling', () => {
  it('treats blank and zero as no limit and refuses anything else', () => {
    expect(parseCeiling('')).toBeNull()
    expect(parseCeiling('0')).toBeNull()
    expect(parseCeiling(' 1500 ')).toBe(1500)
    expect(parseCeiling('12k')).toBeUndefined()
  })
})

describe('UsageCeilingsCard', () => {
  beforeEach(() => invoke.mockReset())

  it('shows use against the 5 hour limit and saves an edited weekly one', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_usage_ceilings') {
        return {
          tokensPer5h: 1000,
          tokensPerWeek: null,
          standings: [
            {
              ceiling: 'tokens per 5 hours',
              used: 400,
              limit: 1000,
              freesInSecs: 4 * 3600,
            },
          ],
        }
      }
      return { tokensPer5h: 1000, tokensPerWeek: 50000, standings: [] }
    })
    render(<UsageCeilingsCard />)
    await waitFor(() => expect(screen.getByTestId('usage-meter')).toBeTruthy())
    expect(screen.getByText('400 / 1,000')).toBeTruthy()
    expect(screen.getByText('Oldest use ages out in 4h 0m')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Tokens per week'), {
      target: { value: '50000' },
    })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('set_usage_ceilings', {
        tokensPer5h: 1000,
        tokensPerWeek: 50000,
      })
    )
  })
})
