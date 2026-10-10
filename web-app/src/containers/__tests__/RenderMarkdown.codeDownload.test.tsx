import { render, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'

vi.mock('@i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const BUTTON = '[data-streamdown="code-block-download-button"]'

describe('RenderMarkdown code block download', () => {
  afterEach(() => vi.restoreAllMocks())

  it('saves a block under the filename its fence declares', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        names.push(this.download)
      }
    )

    const { container } = render(
      <RenderMarkdown content={'```css styles.css\nh1 { color: red; }\n```'} />
    )
    await waitFor(() => expect(container.querySelector(BUTTON)).not.toBeNull())
    fireEvent.click(container.querySelector(BUTTON)!)

    expect(names).toEqual(['styles.css'])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('leaves a block that names nothing to the default handler', async () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function (this: HTMLAnchorElement) {
        names.push(this.download)
      }
    )

    const { container } = render(
      <RenderMarkdown content={'```js\nconsole.log(1)\n```'} />
    )
    await waitFor(() => expect(container.querySelector(BUTTON)).not.toBeNull())
    fireEvent.click(container.querySelector(BUTTON)!)

    // Streamdown's own handler: `file.<ext>`.
    expect(names).toEqual(['file.js'])
  })
})
