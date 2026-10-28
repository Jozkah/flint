/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import en from '@/locales/en/hub.json'

const h = vi.hoisted(() => ({
  search: vi.fn(),
  files: vi.fn(),
  readme: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
  useNavigate: () => vi.fn(),
  useParams: () => ({ modelId: 'acme/tiny' }),
  useSearch: () => ({ repo: 'acme/tiny' }),
}))
// Every string comes back as a marker, so a literal that skipped t() stands out.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => `«${key}»`,
    i18n: { language: 'en' },
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (select: (s: any) => unknown) =>
    select({ huggingfaceToken: '' }),
}))
vi.mock('@/hooks/useFitContext', () => ({
  useFitContext: () => ({ hardware: {}, devices: [] }),
}))
vi.mock('@/containers/HuggingFaceAvatar', () => ({
  HuggingFaceAvatar: () => null,
}))
vi.mock('@/containers/HuggingFaceDownloadAction', () => ({
  HuggingFaceDownloadAction: () => null,
}))
vi.mock('@/containers/RenderMarkdown', () => ({
  RenderMarkdown: () => null,
}))
vi.mock('@/lib/huggingface', async () => ({
  ...(await vi.importActual<any>('@/lib/huggingface')),
  searchHuggingFaceModels: h.search,
  getHuggingFaceFiles: h.files,
  getHuggingFaceReadme: h.readme,
}))
vi.mock('@/lib/huggingfaceFit', async () => ({
  ...(await vi.importActual<any>('@/lib/huggingfaceFit')),
  loadRepoArchitecture: async () => null,
}))

import { Route } from '../$modelId'
import { fitSummary } from '@/lib/hubFitSummary'

const OLD_LITERALS = [
  'Loading model',
  'Tight fit',
  'Copy repo',
  'Discover',
  'Open on Hugging Face',
  'Variants (',
  'README',
]

describe('Hub model detail is localized', () => {
  it('shows no hard-coded English once the model has loaded', async () => {
    h.search.mockResolvedValue([
      {
        id: 'acme/tiny',
        author: 'acme',
        downloads: 12345,
        likes: 7,
        gated: false,
        tags: [],
        lastModified: '2026-01-02T00:00:00Z',
        files: [{ name: 'tiny-Q4_K_M.gguf', size: 1_000_000_000 }],
      },
    ])
    h.readme.mockResolvedValue('')
    const Component = (Route as any).component as React.ComponentType
    const { container } = render(<Component />)
    await waitFor(() =>
      expect(screen.getByText(/hub:detail\.copyRepo/)).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(screen.queryByText(/hub:detail\.readmeLoading/)).toBeNull()
    )
    const text = container.textContent ?? ''
    expect(text).toContain('«hub:detail.variantsHeading»')
    expect(text).toContain('«hub:detail.readme»')
    for (const literal of OLD_LITERALS) {
      expect(text).not.toContain(literal)
    }
  })

  it('translates the not-found error and the loading state', async () => {
    h.search.mockResolvedValue([])
    const Component = (Route as any).component as React.ComponentType
    render(<Component />)
    expect(screen.getByText(/hub:detail\.loading/)).toBeInTheDocument()
    expect(
      await screen.findByText('«hub:detail.errorNotFound»')
    ).toBeInTheDocument()
    expect(screen.getByText('«hub:detail.unavailable»')).toBeInTheDocument()
  })
})

describe('fitSummary', () => {
  const lookup = (key: string) =>
    key
      .replace('hub:', '')
      .split('.')
      .reduce<any>((node, part) => node?.[part], en)

  it('maps every verdict to keys that exist in en/hub.json', () => {
    const verdicts = [
      'fits',
      'fits-partial-offload',
      'tight',
      'exceeds',
      'unknown',
    ]
    for (const verdict of verdicts) {
      const summary = fitSummary({
        verdict,
        required: { total: 2_000_000_000 },
      } as any)
      expect(typeof lookup(summary.titleKey), verdict).toBe('string')
      expect(typeof lookup(summary.detailKey), verdict).toBe('string')
    }
  })

  it('carries the size for the fits verdict', () => {
    const summary = fitSummary({
      verdict: 'fits',
      required: { total: 2_000_000_000 },
    } as any)
    expect(summary.detailValues?.size).toBeTruthy()
  })
})
