import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const resume = vi.fn().mockResolvedValue(undefined)
const retry = vi.fn().mockResolvedValue(undefined)
const cancel = vi.fn().mockResolvedValue(undefined)

vi.mock('@/hooks/useHuggingFaceDownloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useHuggingFaceDownloads')>()
  return {
    ...actual,
    resumeHuggingFaceBundle: (id: string) => resume(id),
    retryHuggingFaceBundle: (id: string) => retry(id),
    cancelHuggingFaceBundle: (id: string) => cancel(id),
  }
})
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.error ? `${key}:${vars.error}` : key,
  }),
}))

import { PausedDownloads } from '@/containers/PausedDownloads'
import { useHuggingFaceDownloads } from '@/hooks/useHuggingFaceDownloads'

const task = (id: string, status: 'paused' | 'error' | 'downloading', error?: string) => ({
  id,
  repo: `org/${id}`,
  label: id,
  status,
  files: [],
  paths: [],
  currentFileIndex: 0,
  downloaded: 50,
  total: 200,
  progress: 0.25,
  error,
})

beforeEach(() => {
  resume.mockClear()
  retry.mockClear()
  cancel.mockClear()
  useHuggingFaceDownloads.setState({ tasks: {} })
})

describe('PausedDownloads', () => {
  it('shows nothing while no download is stopped', () => {
    useHuggingFaceDownloads.setState({ tasks: { a: task('a', 'downloading') } })
    const { container } = render(<PausedDownloads />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists a paused download with its progress and resumes it', () => {
    useHuggingFaceDownloads.setState({ tasks: { a: task('a', 'paused') } })
    render(<PausedDownloads />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText(/25%/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('sweep:hub.resume'))
    expect(resume).toHaveBeenCalledWith('a')
  })

  it('offers Retry for a failed download and cancels from the row', () => {
    useHuggingFaceDownloads.setState({ tasks: { b: task('b', 'error', 'disk full') } })
    render(<PausedDownloads />)
    expect(screen.getByText('sweep:hub.downloadFailedWith:disk full')).toBeInTheDocument()
    fireEvent.click(screen.getByText('sweep:hub.retry'))
    expect(retry).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByLabelText('common:a11y.cancelDownload'))
    expect(cancel).toHaveBeenCalledWith('b')
  })
})
