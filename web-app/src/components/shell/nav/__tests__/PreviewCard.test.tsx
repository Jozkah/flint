import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  PREVIEW_CARD_CLASS,
  PREVIEW_PR_LIMIT,
  PreviewCard,
  PreviewPullRequests,
  formatPreviewTime,
  formatRelativeTime,
  prRepo,
} from '../PreviewCard'
import type { PrStatus } from '@/stores/pr-status-store'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) =>
      o?.count !== undefined ? `${k}#${o.count}` : k,
  }),
}))

const openUrl = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ opener: () => ({ openUrl }) }),
}))

beforeAll(() => {
  document.documentElement.lang = 'en'
})

const pr = (n: number, over: Partial<PrStatus> = {}): PrStatus => ({
  number: n,
  title: `Pull request ${n}`,
  url: `https://github.com/acme/weather/pull/${n}`,
  state: 'open',
  head: `flint/branch-${n}`,
  base: 'main',
  additions: 10,
  deletions: 2,
  checks: { passed: 1, failed: 0, pending: 0 },
  ...over,
})

describe('formatPreviewTime', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0)

  it('names today and yesterday with a 24-hour time', () => {
    expect(formatPreviewTime(new Date(2026, 9, 15, 9, 5).getTime(), now)).toMatch(/^Today, 09:05$/)
    expect(formatPreviewTime(new Date(2026, 9, 14, 23, 36).getTime(), now)).toMatch(/^Yesterday, 23:36$/)
  })

  it('uses the date once it is a week old', () => {
    const text = formatPreviewTime(new Date(2026, 8, 3, 10, 18).getTime(), now)
    expect(text).toMatch(/Sep/)
    expect(text).toMatch(/10:18$/)
  })
})

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 9, 15, 12)
  it('is short for the last week and absent after it', () => {
    expect(formatRelativeTime(now - 30_000, now)).toMatch(/now/i)
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 hr ago')
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toMatch(/2 days/)
    expect(formatRelativeTime(now - 9 * 86_400_000, now)).toBeUndefined()
  })
})

describe('PreviewCard', () => {
  it('clamps a long title, shows the status chip, place, model, time and count', () => {
    render(
      <PreviewCard
        title={'x'.repeat(400)}
        status="running"
        meta={{ place: ['acme-weather', 'web'], branch: 'flint/radar', model: 'Qwen3 8B', updated: Date.now(), messages: 6 }}
        summary="What it is about"
      />
    )
    const title = screen.getByTestId('row-preview-title')
    expect(title.className).toContain('line-clamp-2')
    expect(title.className).toContain('break-words')
    expect(screen.getByTestId('row-preview-status').textContent).toBe('common:rowPreview.status.running')
    expect(screen.getByTestId('row-preview-place').textContent).toContain('acme-weather')
    expect(screen.getByTestId('row-preview-place').textContent).toContain('flint/radar')
    expect(screen.getByTestId('row-preview-meta').textContent).toContain('Qwen3 8B')
    expect(screen.getByTestId('row-preview-time').textContent).toMatch(/Today, \d\d:\d\d/)
    expect(screen.getByTestId('row-preview-count').textContent).toBe('common:previewMessageCount#6')
    expect(screen.getByTestId('row-preview-summary').className).toContain('line-clamp-4')
  })

  it('shows no chip when idle, an empty state without a summary, and no time line without a time', () => {
    render(<PreviewCard title="Untitled" />)
    expect(screen.queryByTestId('row-preview-status')).toBeNull()
    expect(screen.queryByTestId('row-preview-time')).toBeNull()
    expect(screen.queryByTestId('row-preview-summary')).toBeNull()
    expect(screen.getByTestId('row-preview-empty').textContent).toBe('common:rowPreview.empty')
  })

  it('says there are no messages yet for a chat known to be empty', () => {
    render(<PreviewCard title="acme | issue #9 | PR #12" meta={{ messages: 0 }} />)
    expect(screen.getByTestId('row-preview-empty').textContent).toBe(
      'common:rowPreview.noMessages'
    )
  })

  it('hides a summary that only repeats the title', () => {
    render(<PreviewCard title="Fix the radar retry" summary=" Fix the radar retry " />)
    expect(screen.queryByTestId('row-preview-summary')).toBeNull()
    expect(screen.getByTestId('row-preview-empty')).toBeTruthy()
  })

  it('fits its content between 18 and 24rem and never outgrows the viewport', () => {
    expect(PREVIEW_CARD_CLASS).toContain('min-w-[18rem]')
    expect(PREVIEW_CARD_CLASS).toMatch(/max-w-\[min\(24rem/)
    expect(PREVIEW_CARD_CLASS).toMatch(/max-h-\[min\(calc\(100vh-2rem\)/)
    expect(PREVIEW_CARD_CLASS).toContain('overflow-y-auto')
  })

  it('says a summary is being written while nothing is shown yet', () => {
    render(<PreviewCard title="T" summaryLoading />)
    expect(screen.getByTestId('row-preview-empty').textContent).toBe('common:rowPreview.summarizing')
  })

  it('wraps an unbroken summary and keeps the card width fixed', () => {
    render(<PreviewCard title="T" summary={'a'.repeat(600)} />)
    expect(screen.getByTestId('row-preview-summary').className).toContain('break-words')
  })

  it('shows the keyboard hint only when asked', () => {
    const { rerender } = render(<PreviewCard title="T" hint />)
    expect(screen.getByTestId('row-preview-hint')).toBeTruthy()
    rerender(<PreviewCard title="T" />)
    expect(screen.queryByTestId('row-preview-hint')).toBeNull()
  })
})

describe('PreviewPullRequests', () => {
  it('renders nothing with no pull requests and nothing in flight', () => {
    const { container } = render(<PreviewPullRequests prs={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('lists one pull request with its state, repository, number, size, branch and checks', () => {
    render(<PreviewPullRequests prs={[pr(12, { state: 'merged', additions: 509, deletions: 14, checks: { passed: 3, failed: 1, pending: 2 } })]} />)
    const row = screen.getByTestId('preview-pr')
    expect(row.getAttribute('data-state')).toBe('merged')
    expect(row.textContent).toContain('common:rowPreview.prState.merged')
    expect(row.textContent).toContain('acme/weather')
    expect(row.textContent).toContain('#12')
    expect(row.textContent).toContain('+509')
    expect(row.textContent).toContain('−14')
    expect(row.textContent).toContain('flint/branch-12')
    const checks = screen.getByTestId('preview-pr-checks')
    expect(checks.querySelector('[data-verdict=failed]')?.textContent).toBe('1')
    expect(checks.querySelector('[data-verdict=pending]')?.textContent).toBe('2')
    expect(checks.querySelector('[data-verdict=passed]')?.textContent).toBe('3')
    expect(screen.queryByTestId('preview-prs-more')).toBeNull()
  })

  it('says when no checks ran, and when a status could not be read', () => {
    render(
      <PreviewPullRequests
        prs={[
          pr(1, { checks: { passed: 0, failed: 0, pending: 0 } }),
          pr(2, { statusError: 'gh: HTTP 502' }),
          pr(3, { title: '' }),
        ]}
      />
    )
    expect(screen.getByTestId('preview-pr-nochecks')).toBeTruthy()
    expect(screen.getByTestId('preview-pr-error').getAttribute('title')).toBe('gh: HTTP 502')
  })

  it('names an unread pull request by its branch, with a muted status line and no placeholder', () => {
    render(<PreviewPullRequests prs={[pr(3, { title: '', head: 'flint/branch-3' })]} />)
    const row = screen.getByTestId('preview-pr')
    expect(row.querySelector('[data-slot=skeleton]')).toBeNull()
    expect(screen.getByTestId('preview-pr-title').textContent).toBe('flint/branch-3')
    expect(screen.getByTestId('preview-pr-status-pending').textContent).toBe('common:pr.statusUnavailable')
    expect(screen.getByTestId('preview-pr-status-pending').className).not.toContain('destructive')
    expect(screen.queryByTestId('preview-pr-nochecks')).toBeNull()
  })

  it('folds the list past the limit behind "+N more", which unfolds it', () => {
    const prs = Array.from({ length: 7 }, (_, i) => pr(i + 1))
    render(<PreviewPullRequests prs={prs} />)
    expect(screen.getAllByTestId('preview-pr')).toHaveLength(PREVIEW_PR_LIMIT)
    const more = screen.getByTestId('preview-prs-more')
    expect(more.textContent).toBe(`common:rowPreview.morePrs#${7 - PREVIEW_PR_LIMIT}`)
    fireEvent.click(more)
    expect(screen.getAllByTestId('preview-pr')).toHaveLength(7)
    expect(screen.queryByTestId('preview-prs-more')).toBeNull()
  })

  it('shows a loading placeholder, then an error, when nothing is known', () => {
    const { rerender } = render(<PreviewPullRequests prs={[]} loading />)
    expect(screen.getByTestId('preview-prs-loading')).toBeTruthy()
    rerender(<PreviewPullRequests prs={[]} error="gh_signed_out" />)
    expect(screen.getByTestId('preview-prs-error').getAttribute('title')).toBe('gh_signed_out')
  })
})

describe('prRepo', () => {
  it('reads owner/name from a GitHub URL', () => {
    expect(prRepo('https://github.com/Jozkah/flint/pull/346')).toBe('Jozkah/flint')
    expect(prRepo('https://example.com/x')).toBeUndefined()
  })
})

describe('PreviewPullRequests links', () => {
  it('makes each pull request a focusable link that opens through the app opener', () => {
    render(<PreviewPullRequests prs={[pr(7)]} />)
    const link = screen.getByTestId('preview-pr-link') as HTMLAnchorElement
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://github.com/acme/weather/pull/7')
    link.focus()
    expect(document.activeElement).toBe(link)
    fireEvent.click(link)
    expect(openUrl).toHaveBeenCalledWith('https://github.com/acme/weather/pull/7')
  })
})
