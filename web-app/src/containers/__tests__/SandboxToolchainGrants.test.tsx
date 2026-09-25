import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SandboxToolchainGrants } from '../SandboxToolchainGrants'

const getSandboxToolchains = vi.fn()
const sandboxToolchainGrants = vi.fn()
const sandboxToolchainGrant = vi.fn()
const sandboxToolchainRevoke = vi.fn()

vi.mock('@/lib/agentTools', () => ({
  getSandboxToolchains: (...a: unknown[]) => getSandboxToolchains(...a),
}))
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  sandboxToolchainGrants: (...a: unknown[]) => sandboxToolchainGrants(...a),
  sandboxToolchainGrant: (...a: unknown[]) => sandboxToolchainGrant(...a),
  sandboxToolchainRevoke: (...a: unknown[]) => sandboxToolchainRevoke(...a),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/containers/Card', () => ({
  CardItem: ({
    title,
    description,
    actions,
  }: {
    title: React.ReactNode
    description: React.ReactNode
    actions: React.ReactNode
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
      {actions}
    </div>
  ),
}))

describe('SandboxToolchainGrants', () => {
  beforeEach(() => {
    for (const f of [
      getSandboxToolchains,
      sandboxToolchainGrants,
      sandboxToolchainGrant,
      sandboxToolchainRevoke,
    ]) {
      f.mockReset()
    }
  })

  it('renders nothing where the sandbox reports no toolchains', async () => {
    getSandboxToolchains.mockResolvedValue(null)
    sandboxToolchainGrants.mockResolvedValue([])
    const { container } = render(<SandboxToolchainGrants />)
    await waitFor(() => expect(sandboxToolchainGrants).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('grants only after the user confirms the permission change', async () => {
    getSandboxToolchains.mockResolvedValue({ runnable: [], unavailable: ['python'] })
    sandboxToolchainGrants.mockResolvedValue([])
    sandboxToolchainGrant.mockResolvedValue({
      program: 'python',
      folder: 'C:\\Users\\me\\Python311',
      grantedAt: 1,
    })
    render(<SandboxToolchainGrants />)
    fireEvent.click(await screen.findByTestId('toolchain-grant-python'))
    expect(sandboxToolchainGrant).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings:agentTools.toolchains.confirmBody')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('toolchain-grant-confirm'))
    await waitFor(() => expect(sandboxToolchainGrant).toHaveBeenCalledWith('python'))
  })

  it('revokes a granted folder', async () => {
    getSandboxToolchains.mockResolvedValue({ runnable: ['python'], unavailable: [] })
    sandboxToolchainGrants.mockResolvedValue([
      { program: 'python', folder: 'C:\\Users\\me\\Python311', grantedAt: 1 },
    ])
    sandboxToolchainRevoke.mockResolvedValue(undefined)
    render(<SandboxToolchainGrants />)
    fireEvent.click(await screen.findByTestId('toolchain-revoke-python'))
    await waitFor(() =>
      expect(sandboxToolchainRevoke).toHaveBeenCalledWith('C:\\Users\\me\\Python311')
    )
  })
})
