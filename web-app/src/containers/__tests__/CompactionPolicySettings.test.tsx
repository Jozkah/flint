import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CompactionPolicySettings } from '../CompactionPolicySettings'
import { DEFAULT_COMPACTION_POLICY } from '@/lib/compactionPolicy'

const getCompactionPolicy = vi.fn()
const setCompactionPolicy = vi.fn()

vi.mock('@/lib/compactionPolicy', async (orig) => ({
  ...(await orig<typeof import('@/lib/compactionPolicy')>()),
  getCompactionPolicy: (...a: unknown[]) => getCompactionPolicy(...a),
  setCompactionPolicy: (...a: unknown[]) => setCompactionPolicy(...a),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
  CardItem: ({ title, description, actions }: { title: string; description: string; actions: React.ReactNode }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
      {actions}
    </div>
  ),
}))

describe('CompactionPolicySettings (AH-076)', () => {
  beforeEach(() => {
    getCompactionPolicy.mockReset()
    setCompactionPolicy.mockReset()
  })

  it('shows the effective policy and marks a value a project overrides', async () => {
    getCompactionPolicy.mockResolvedValue({
      ...DEFAULT_COMPACTION_POLICY,
      keepRecent: 4,
      origins: { ...DEFAULT_COMPACTION_POLICY.origins, keepRecent: 'project' },
    })
    render(<CompactionPolicySettings />)
    await waitFor(() =>
      expect(screen.getByLabelText('settings:compaction.keepRecent')).toHaveValue(4)
    )
    expect(
      screen.getByText(/keepRecentDescription settings:compaction\.projectOverride/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/autoDescription settings:compaction\.projectOverride/)).toBeNull()
  })

  it('saves only the field that changed', async () => {
    getCompactionPolicy.mockResolvedValue(DEFAULT_COMPACTION_POLICY)
    setCompactionPolicy.mockResolvedValue({ ...DEFAULT_COMPACTION_POLICY, strategy: 'trim' })
    render(<CompactionPolicySettings />)
    const select = await screen.findByLabelText('settings:compaction.strategy')
    fireEvent.change(select, { target: { value: 'trim' } })
    await waitFor(() => expect(setCompactionPolicy).toHaveBeenCalledWith({ strategy: 'trim' }))
    const keep = screen.getByLabelText('settings:compaction.keepRecent')
    fireEvent.change(keep, { target: { value: '12' } })
    fireEvent.blur(keep)
    await waitFor(() => expect(setCompactionPolicy).toHaveBeenLastCalledWith({ keepRecent: 12 }))
  })

  it("reports the backend's refusal instead of pretending it saved", async () => {
    getCompactionPolicy.mockResolvedValue(DEFAULT_COMPACTION_POLICY)
    setCompactionPolicy.mockRejectedValue('compaction.json: keepRecent must be between 2 and 200, not 1')
    render(<CompactionPolicySettings />)
    const keep = await screen.findByLabelText('settings:compaction.keepRecent')
    fireEvent.change(keep, { target: { value: '1' } })
    fireEvent.blur(keep)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('keepRecent must be between'))
  })

  it('shows an unreadable policy file as an error, not as defaults', async () => {
    getCompactionPolicy.mockRejectedValue('compaction.json: unknown field `keepRecnt`')
    render(<CompactionPolicySettings />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('keepRecnt'))
    expect(screen.queryByLabelText('settings:compaction.keepRecent')).toBeNull()
  })
})
