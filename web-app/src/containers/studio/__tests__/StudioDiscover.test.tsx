import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  families: vi.fn(),
  guessFamily: vi.fn(),
  search: vi.fn(),
  files: vi.fn(),
  refresh: vi.fn(),
  // One object, so the component's effects do not see a new store value each render.
  status: { supported: true, models: [] },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/containers/HuggingFaceAvatar', () => ({
  HuggingFaceAvatar: () => null,
}))
vi.mock('@/hooks/useStudio', () => ({
  useStudio: (select: (s: unknown) => unknown) =>
    select({ status: h.status, refresh: h.refresh }),
}))
vi.mock('@/lib/studio/studio', () => ({
  studioApi: {
    families: h.families,
    guessFamily: h.guessFamily,
    addCustomModel: vi.fn(),
  },
}))
vi.mock('@/lib/huggingface', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/huggingface')>(
      '@/lib/huggingface'
    )
  return {
    ...actual,
    searchHuggingFaceModels: h.search,
    getHuggingFaceFiles: h.files,
  }
})

import { StudioDiscover } from '../StudioDiscover'

const repo = {
  id: 'acme/img-gguf',
  downloads: 1,
  likes: 1,
  files: [],
  tags: [],
}

describe('StudioDiscover errors', () => {
  beforeEach(() => {
    h.families.mockReset().mockResolvedValue([])
    h.guessFamily.mockReset().mockResolvedValue(null)
    h.search.mockReset().mockResolvedValue([repo])
    h.files.mockReset()
  })

  it('shows an error with Retry when the model kinds fail to load', async () => {
    h.families.mockRejectedValueOnce(new Error('offline'))
    render(<StudioDiscover query="" />)
    expect(await screen.findByText(/offline/)).toBeInTheDocument()
    h.families.mockResolvedValue([{ id: 'flux', label: 'Flux', description: '' }])
    fireEvent.click(screen.getByTestId('studio-families-retry'))
    await waitFor(() => expect(screen.queryByText(/offline/)).toBeNull())
    expect(h.families).toHaveBeenCalledTimes(2)
  })

  it('a failed file listing is an error with Retry, not "No weights files"', async () => {
    h.files.mockRejectedValueOnce(new Error('rate limited'))
    render(<StudioDiscover query="" />)
    fireEvent.click(await screen.findByText('Choose a file'))
    expect(await screen.findByText(/rate limited/)).toBeInTheDocument()
    expect(screen.queryByText(/No weights files/)).toBeNull()
    h.files.mockResolvedValue([{ name: 'model-Q4_K_M.gguf', size: 10 }])
    fireEvent.click(screen.getByTestId('studio-files-retry'))
    expect(await screen.findByText('model-Q4_K_M.gguf')).toBeInTheDocument()
  })
})
