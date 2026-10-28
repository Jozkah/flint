import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { EditMessageDialog } from '../EditMessageDialog'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useConversationPane', () => ({
  useConversationModel: () => ({ selectedModel: { id: 'm' } }),
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))

describe('EditMessageDialog', () => {
  it('offers no image removal, since saving cannot carry it, and saves only on a text change', () => {
    const onSave = vi.fn()
    render(
      <EditMessageDialog
        message="hello"
        imageUrls={['data:image/png;base64,AAAA']}
        onSave={onSave}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'common:editMessage' }))
    expect(screen.getByAltText('common:attachedImage')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'common:dismiss' })
    ).toBeNull()
    const save = screen.getByRole('button', { name: 'common:save' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'hello there' },
    })
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith('hello there')
  })
})
