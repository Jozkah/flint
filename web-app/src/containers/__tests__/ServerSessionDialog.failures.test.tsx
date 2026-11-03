import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => ({ selectedModel: null }) },
}))
vi.mock('@/lib/remoteRunner', () => ({
  listRunModels: vi.fn().mockRejectedValue(new Error('down')),
}))
vi.mock('@/lib/remoteCowork', () => ({
  runnerInfo: vi.fn().mockRejectedValue(new Error('down')),
  sendRemoteTurn: vi.fn(),
  startRemoteSession: vi.fn(),
}))
vi.mock('@/containers/ServerFolderChooser', () => ({
  ResponsiveSheet: ({ children, footer }: { children: unknown; footer: unknown }) => (
    <div>
      {children as never}
      {footer as never}
    </div>
  ),
  ServerFolderBrowser: () => null,
}))

import { ServerSessionDialog } from '../ServerSessionDialog'

describe('ServerSessionDialog failures', () => {
  it('tells the user when the runner check fails', async () => {
    render(<ServerSessionDialog open onOpenChange={() => {}} />)
    expect(
      await screen.findByText('integrations:serverSession.checkFailed')
    ).toBeInTheDocument()
  })
})
