import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k} ${JSON.stringify(vars)}` : k,
  }),
}))

const runDiffReview = vi.fn()
const reviewFixTask = vi.fn()
vi.mock('@/lib/coworkReview', () => ({
  runDiffReview: (...a: unknown[]) => runDiffReview(...a),
  reviewFixTask: (...a: unknown[]) => reviewFixTask(...a),
}))

import { CoworkReviewAction } from '../CoworkReviewAction'

const finding = (over: Record<string, unknown> = {}) => ({
  severity: 'high',
  file: 'src/a.rs',
  line: 12,
  problem: 'panics on empty input',
  fix: 'return early',
  verdict: 'confirmed',
  ...over,
})

describe('CoworkReviewAction', () => {
  beforeEach(() => {
    runDiffReview.mockReset()
    reviewFixTask.mockReset()
  })

  it('shows ranked findings with file:line and sends the fix task to the session', async () => {
    runDiffReview.mockResolvedValue({
      findings: [finding(), finding({ severity: 'low', file: 'b.ts', line: null, verdict: 'unverified' })],
      refuted: 1,
      truncated: false,
      files: 2,
    })
    reviewFixTask.mockResolvedValue('fix these')
    const onFix = vi.fn().mockReturnValue(true)
    render(<CoworkReviewAction folder="/p" sessionId="s1" onFix={onFix} />)

    await userEvent.click(screen.getByRole('button', { name: /coworkReview|diffReview.*button/ }))
    expect(await screen.findByText('src/a.rs:12')).toBeTruthy()
    expect(screen.getAllByText('panics on empty input')).toHaveLength(2)
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.getByText('common:diffReview.unverified')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /fixButton/ }))
    await waitFor(() => expect(onFix).toHaveBeenCalledWith('fix these'))
  })

  it('says so when the session is busy and fixes cannot be sent', async () => {
    runDiffReview.mockResolvedValue({ findings: [finding()], refuted: 0, truncated: false, files: 1 })
    reviewFixTask.mockResolvedValue('fix these')
    render(<CoworkReviewAction folder="/p" sessionId="s1" onFix={() => false} />)
    await userEvent.click(screen.getByRole('button', { name: /button/ }))
    await userEvent.click(await screen.findByRole('button', { name: /fixButton/ }))
    expect(await screen.findByText('common:diffReview.fixBusy')).toBeTruthy()
  })

  it('reports a failed review in an alert', async () => {
    runDiffReview.mockRejectedValue(new Error('no model is selected'))
    render(<CoworkReviewAction folder="/p" sessionId="s1" onFix={() => true} />)
    await userEvent.click(screen.getByRole('button', { name: /button/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('no model is selected')
  })

  it('passes the security option through', async () => {
    runDiffReview.mockResolvedValue({ findings: [], refuted: 0, truncated: false, files: 1 })
    render(<CoworkReviewAction folder="/p" sessionId="s1" onFix={() => true} />)
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: /button/ }))
    await screen.findByText('common:diffReview.none')
    expect(runDiffReview.mock.calls[0][0]).toMatchObject({ folder: '/p', security: true })
  })
})
