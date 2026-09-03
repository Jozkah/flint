import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LeaveTemporaryChatDialog } from '@/containers/dialogs/LeaveTemporaryChatDialog'

// Rendered without a TranslationProvider on purpose: the default translation
// context echoes the key, so button/label text below is the i18n key itself.
// That keeps the test about behaviour and accessibility, not copy.

function setup(overrides: Partial<Parameters<typeof LeaveTemporaryChatDialog>[0]> = {}) {
  const onKeep = vi.fn()
  const onDiscard = vi.fn()
  const onCancel = vi.fn()
  render(
    <LeaveTemporaryChatDialog
      open
      onKeep={onKeep}
      onDiscard={onDiscard}
      onCancel={onCancel}
      {...overrides}
    />
  )
  return { onKeep, onDiscard, onCancel }
}

describe('LeaveTemporaryChatDialog', () => {
  it('is a labelled, described dialog with all three choices', () => {
    setup()
    const dialog = screen.getByRole('dialog')
    // Radix wires the title and description as the accessible name/description.
    expect(dialog).toHaveAccessibleName('chat:temporaryChatLeave.title')
    expect(dialog).toHaveAccessibleDescription(
      'chat:temporaryChatLeave.description'
    )
    expect(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.keep' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.discard' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'common:cancel' })
    ).toBeInTheDocument()
  })

  it('focuses Keep when it opens — the safe, non-destructive default', async () => {
    setup()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'chat:temporaryChatLeave.keep' })
      ).toHaveFocus()
    })
  })

  it('routes each button to its handler', () => {
    const { onKeep, onDiscard, onCancel } = setup()

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.keep' })
    )
    expect(onKeep).toHaveBeenCalledTimes(1)

    fireEvent.click(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.discard' })
    )
    expect(onDiscard).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('treats Escape as Cancel', () => {
    const { onCancel, onKeep, onDiscard } = setup()
    fireEvent.keyDown(screen.getByRole('dialog'), {
      key: 'Escape',
      code: 'Escape',
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onKeep).not.toHaveBeenCalled()
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('disables every choice while a keep or discard is running', () => {
    setup({ busy: true })
    expect(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.keep' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'chat:temporaryChatLeave.discard' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'common:cancel' })
    ).toBeDisabled()
  })

  it('renders nothing when closed', () => {
    const onCancel = vi.fn()
    render(
      <LeaveTemporaryChatDialog
        open={false}
        onKeep={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={onCancel}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
