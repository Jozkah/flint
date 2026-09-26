import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodeOpenContext } from '@/lib/codeOpen'
import { FILE_REF_HREF_PREFIX } from '@/lib/coworkFileRefs'
import { CoworkFileRef } from '../CoworkFileRef'

const href = (raw: string) => `${FILE_REF_HREF_PREFIX}${encodeURIComponent(raw)}`

describe('CoworkFileRef', () => {
  it('opens the referenced path when an opener is present (Cowork)', async () => {
    const open = vi.fn()
    render(
      <CodeOpenContext.Provider value={open}>
        <CoworkFileRef href={href('src/a.ts:24')}>@src/a.ts:24</CoworkFileRef>
      </CodeOpenContext.Provider>
    )
    const btn = screen.getByRole('button', { name: '@src/a.ts:24' })
    expect(btn).toHaveAttribute('title', 'src/a.ts:24')
    await userEvent.click(btn)
    // At the referenced line, in the foreground.
    expect(open).toHaveBeenCalledWith('src/a.ts', { line: 24, background: false })
  })

  it('renders inert plain text where no opener is provided (chat)', () => {
    render(<CoworkFileRef href={href('src/a.ts')}>@src/a.ts</CoworkFileRef>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('@src/a.ts')).toBeInTheDocument()
  })

  it('refuses a tampered/unsafe href even with an opener', () => {
    const open = vi.fn()
    render(
      <CodeOpenContext.Provider value={open}>
        <CoworkFileRef href={href('../etc/passwd')}>@../etc/passwd</CoworkFileRef>
      </CodeOpenContext.Provider>
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('@../etc/passwd')).toBeInTheDocument()
  })
})
