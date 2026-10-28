import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TrustedServersSection } from '../TrustedServersSection'
import { StaleApprovalsSection } from '../StaleApprovalsSection'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.server !== undefined ? `${key}:${opts.server}` : key,
  }),
}))

const noop = async () => {}

describe('TrustedServersSection', () => {
  it('says so when no server is trusted', () => {
    render(
      <TrustedServersSection
        servers={[]}
        report={null}
        serversError={null}
        serverErrors={{}}
        busyServer={null}
        onRevokeServer={noop}
      />
    )
    expect(
      screen.getByText('permissions:settings.noTrustedServers')
    ).toBeInTheDocument()
  })

  it('shows the drift state and explanation of a changed server', () => {
    render(
      <TrustedServersSection
        servers={[
          { name: 'files', inBackend: true, inApp: true, state: 'changed' },
        ]}
        report={{ trusted: [], invalidated: [] }}
        serversError={null}
        serverErrors={{}}
        busyServer={null}
        onRevokeServer={noop}
      />
    )
    expect(
      screen.getByTestId('permissions-server-state-files')
    ).toHaveTextContent('permissions:settings.stateChanged')
    expect(
      screen.getByText('permissions:settings.serverChanged')
    ).toBeInTheDocument()
  })
})

describe('StaleApprovalsSection', () => {
  it('lists each approval that needs renewing with its reason', () => {
    render(
      <StaleApprovalsSection
        pendingRenewals={[
          { name: 'old', reason: 'legacy' },
          { name: 'edited', reason: 'changed' },
        ]}
        servers={[]}
        serverErrors={{}}
        busyServer={null}
        onRevokeServer={noop}
      />
    )
    expect(
      screen.getByText('permissions:settings.reasonLegacy')
    ).toBeInTheDocument()
    expect(
      screen.getByText('permissions:settings.reasonChanged')
    ).toBeInTheDocument()
  })
})
