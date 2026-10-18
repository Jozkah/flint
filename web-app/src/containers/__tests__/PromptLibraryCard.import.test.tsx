import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => (o?.count != null ? `${k}:${o.count}` : k),
  }),
}))

import { PromptLibraryCard } from '../PromptLibraryCard'
import { usePromptLibrary } from '@/lib/promptLibrary'

describe('PromptLibraryCard import (PL-026)', () => {
  beforeEach(() => {
    toast.success.mockReset()
    usePromptLibrary.setState({ prompts: [] })
    usePromptLibrary.getState().add({ name: 'A', body: 'body A' })
  })

  it('says nothing new was found instead of "Added 0 prompts"', async () => {
    const { container } = render(<PromptLibraryCard />)
    const same = usePromptLibrary.getState().exportJson()
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File([same], 'p.json', { type: 'application/json' })] },
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalledWith('common:promptLibrary.importedNone')
  })
})
