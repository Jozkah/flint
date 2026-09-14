import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { VisionDisabledDialog } from '@/containers/dialogs/VisionDisabledDialog'

// Rendered without a TranslationProvider on purpose: the default translation
// context echoes the key, so the button text below is the i18n key itself.
// That keeps the test about behaviour, not copy.

function setup(
  overrides: Partial<Parameters<typeof VisionDisabledDialog>[0]> = {}
) {
  const onChoose = vi.fn()
  render(
    <VisionDisabledDialog
      open
      fileNames={['shot.png']}
      modelName="some-model"
      canEnable
      onChoose={onChoose}
      {...overrides}
    />
  )
  return { onChoose }
}

// This suite does not run with the global auto-cleanup, so each test tidies up
// after itself; otherwise a previous dialog is still mounted and "the enable
// button is absent" would find the one before it.
afterEach(cleanup)

describe('VisionDisabledDialog', () => {
  it.each([
    ['common:cancel', 'cancel'],
    ['common:attachFiles.visionDisabled.proceed', 'proceed'],
    ['common:attachFiles.visionDisabled.enable', 'enable'],
  ])('reports the choice behind %s', (label, choice) => {
    const { onChoose } = setup()
    fireEvent.click(screen.getByText(label))
    expect(onChoose).toHaveBeenCalledWith(choice)
  })

  it('names the images, so the user knows what is at stake', () => {
    setup({ fileNames: ['shot.png', 'diagram.jpg'] })
    expect(screen.getByTestId('vision-disabled-files')).toHaveTextContent(
      'shot.png, diagram.jpg'
    )
  })

  /**
   * A local model with no mmproj cannot be made to see by flipping a switch,
   * so the offer is withheld rather than leading to a request that fails.
   */
  it('withholds the offer when turning vision on would not work', () => {
    setup({ canEnable: false })
    expect(
      screen.queryByText('common:attachFiles.visionDisabled.enable')
    ).toBeNull()
    expect(
      screen.getByText('common:attachFiles.visionDisabled.needsMmproj')
    ).toBeInTheDocument()
  })

  /** Dismissing leaves the draft alone, which is what cancelling means. */
  it('treats dismissal as a cancel', () => {
    const { onChoose } = setup()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onChoose).toHaveBeenCalledWith('cancel')
  })
})
