import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ApprovalRulesCard } from '../ApprovalRulesCard'
import * as scopes from '@/lib/approvalScopes'
import { toast } from 'sonner'
import en from '@/locales/en/permissions.json'

// The real English strings, so the tests read what the person reads.
const t = (key: string, opts?: Record<string, string>) => {
  const path = key.replace('permissions:', '').split('.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v: any = en
  for (const p of path) v = v?.[p]
  return String(v ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? '')
}
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/approvalScopes', async (orig) => ({
  ...(await orig<typeof import('@/lib/approvalScopes')>()),
  listScopedRules: vi.fn(),
  revokeScopedRule: vi.fn(),
  listDeferred: vi.fn(),
  answerDeferred: vi.fn(),
  discardDeferred: vi.fn(),
}))

const RULE_FOLDER: scopes.ScopedRule = {
  id: 'rule-1',
  project: 'c:/proj',
  tool: 'write',
  kind: 'write',
  scope: { type: 'folder', dir: 'C:/proj/src' },
  createdAt: 1,
}
const RULE_PREFIX: scopes.ScopedRule = {
  id: 'rule-2',
  project: 'c:/proj',
  tool: 'bash',
  kind: 'exec',
  scope: { type: 'command_prefix', prefix: 'cargo test' },
  createdAt: 2,
}
const WAITING: scopes.DeferredApproval = {
  id: 'defer-1',
  project: 'c:/proj',
  session: 'sess-9',
  tool: 'bash',
  kind: 'exec',
  summary: 'bash: make deploy',
  argsDigest: 'abc',
  status: 'pending',
  createdAt: 1,
  expiresAt: 4_000_000_000,
  answeredAt: null,
}

describe('ApprovalRulesCard', () => {
  beforeEach(() => {
    // The desktop backend is present (a page served to a browser has none).
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
    vi.mocked(scopes.listScopedRules).mockReset().mockResolvedValue([])
    vi.mocked(scopes.revokeScopedRule).mockReset()
    vi.mocked(scopes.listDeferred).mockReset().mockResolvedValue([])
    vi.mocked(scopes.answerDeferred).mockReset()
    vi.mocked(scopes.discardDeferred).mockReset()
    vi.mocked(toast.error).mockReset()
  })

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('does not call the backend on a page served to a browser', async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    render(<ApprovalRulesCard />)
    expect(await screen.findByTestId('approval-rules-desktop-only')).toBeTruthy()
    expect(screen.getByTestId('deferred-approvals-desktop-only')).toBeTruthy()
    expect(scopes.listScopedRules).not.toHaveBeenCalled()
    expect(scopes.listDeferred).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('names the item on each waiting approval button', async () => {
    vi.mocked(scopes.listDeferred).mockResolvedValue([WAITING])
    render(<ApprovalRulesCard />)
    expect(
      await screen.findByRole('button', { name: new RegExp(`^Allow: ${WAITING.summary}`) })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: new RegExp(`^Deny: ${WAITING.summary}`) })
    ).toBeTruthy()
  })

  it('lists each rule with its scope in words and its project', async () => {
    vi.mocked(scopes.listScopedRules).mockResolvedValue([RULE_FOLDER, RULE_PREFIX])
    render(<ApprovalRulesCard />)
    const rows = await screen.findAllByTestId('approval-rule-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Inside C:/proj/src')
    expect(rows[1].textContent).toContain('Commands that start with cargo test')
    expect(rows[0].textContent).toContain('In c:/proj')
  })

  it('shows the empty states', async () => {
    render(<ApprovalRulesCard />)
    expect(await screen.findByTestId('approval-rules-empty')).toBeTruthy()
    expect(await screen.findByTestId('deferred-approvals-empty')).toBeTruthy()
  })

  it('revokes one rule and reloads', async () => {
    vi.mocked(scopes.listScopedRules)
      .mockResolvedValueOnce([RULE_FOLDER, RULE_PREFIX])
      .mockResolvedValue([RULE_PREFIX])
    vi.mocked(scopes.revokeScopedRule).mockResolvedValue(true)
    render(<ApprovalRulesCard />)
    const buttons = await screen.findAllByRole('button', { name: /Revoke the approval/ })
    fireEvent.click(buttons[0])
    await waitFor(() => expect(scopes.revokeScopedRule).toHaveBeenCalledWith('rule-1'))
    await waitFor(() => expect(screen.getAllByTestId('approval-rule-row')).toHaveLength(1))
  })

  it('says so when a revoke fails and keeps the list', async () => {
    vi.mocked(scopes.listScopedRules).mockResolvedValue([RULE_FOLDER])
    vi.mocked(scopes.revokeScopedRule).mockRejectedValue(new Error('nope'))
    render(<ApprovalRulesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /Revoke the approval/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getAllByTestId('approval-rule-row')).toHaveLength(1)
  })

  it('answers a waiting approval and never offers to allow one that is settled', async () => {
    vi.mocked(scopes.listDeferred)
      .mockResolvedValueOnce([WAITING, { ...WAITING, id: 'defer-2', status: 'expired' }])
      .mockResolvedValue([])
    vi.mocked(scopes.answerDeferred).mockResolvedValue({ ...WAITING, status: 'allowed' })
    render(<ApprovalRulesCard />)
    const rows = await screen.findAllByTestId('deferred-approval-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Waiting')
    expect(rows[0].textContent).toContain('Session sess-9')
    // The expired one can only be removed.
    expect(rows[1].textContent).toContain('Expired')
    expect(rows[1].textContent).not.toContain('Allow')
    fireEvent.click(rows[0].querySelector('button:last-child') as HTMLElement)
    await waitFor(() => expect(scopes.answerDeferred).toHaveBeenCalledWith('defer-1', true))
  })

  it('denies a waiting approval', async () => {
    vi.mocked(scopes.listDeferred).mockResolvedValue([WAITING])
    vi.mocked(scopes.answerDeferred).mockResolvedValue({ ...WAITING, status: 'denied' })
    render(<ApprovalRulesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /^Deny: bash: make deploy/ }))
    await waitFor(() => expect(scopes.answerDeferred).toHaveBeenCalledWith('defer-1', false))
  })

  it('shows a late answer being refused', async () => {
    vi.mocked(scopes.listDeferred).mockResolvedValue([WAITING])
    vi.mocked(scopes.answerDeferred).mockRejectedValue('defer-1 expired before it was answered')
    render(<ApprovalRulesCard />)
    fireEvent.click(await screen.findByRole('button', { name: /^Allow: bash: make deploy/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain('expired')
  })
})
