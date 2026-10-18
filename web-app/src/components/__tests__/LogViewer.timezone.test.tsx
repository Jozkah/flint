// The app log is written in UTC; the server log card must show local time.
// Pinned to UTC+2 (no DST) so the check means the same on every machine.
process.env.TZ = 'Etc/GMT-2'

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/hooks/useServerLogs', () => ({
  useServerLogs: () => [
    { timestamp: '2026-10-17 19:16:30', level: 'info', target: 'app', message: 'API server request: POST /v1/responses' },
  ],
  logKey: (l: { timestamp: string }) => l.timestamp,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { LogViewer } from '../LogViewer'

describe('server log times', () => {
  it('reads the UTC log stamp and shows it in local time', () => {
    expect(new Date(Date.UTC(2026, 9, 17, 19, 16, 30)).getHours()).toBe(21)
    render(<LogViewer />)
    expect(screen.getByText('[21:16:30]')).toBeInTheDocument()
  })
})
