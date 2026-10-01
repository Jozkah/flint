import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k}#${Object.values(opts).join(',')}` : k,
  }),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ core: () => ({ invoke: vi.fn() }) }),
}))

import { toast } from 'sonner'
import { InlinePathLink } from '../message/InlinePathLink'
import { pathHref } from '@/lib/pathOpen'
import { resetMissingPaths } from '@/lib/missingPaths'
import {
  CodeOpenContext,
  CodeOpenToolsContext,
  PathRootsContext,
} from '@/lib/codeOpen'

const mount = (exists: ((p: string) => Promise<boolean>) | undefined) => {
  const open = vi.fn()
  render(
    <PathRootsContext.Provider value={['/ws/s1']}>
      <CodeOpenContext.Provider value={open}>
        <CodeOpenToolsContext.Provider value={{ exists }}>
          <InlinePathLink href={pathHref('src/nope.ts')}>src/nope.ts</InlinePathLink>
        </CodeOpenToolsContext.Provider>
      </CodeOpenContext.Provider>
    </PathRootsContext.Provider>
  )
  return open
}

describe('InlinePathLink existence check', () => {
  beforeEach(() => {
    vi.mocked(toast.info).mockClear()
    resetMissingPaths()
  })

  it('opens nothing and toasts when the file is missing, then dims the link', async () => {
    const exists = vi.fn(async () => false)
    const open = mount(exists)
    const link = screen.getByRole('button', { name: 'src/nope.ts' })
    expect(link).not.toHaveAttribute('data-missing')
    // Rendering alone never touches the filesystem.
    expect(exists).not.toHaveBeenCalled()

    await userEvent.click(link)

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1))
    expect(toast.info).toHaveBeenCalledWith(
      'common:codePanel.pathNotFound#src/nope.ts'
    )
    expect(open).not.toHaveBeenCalled()
    await waitFor(() => expect(link).toHaveAttribute('data-missing', 'true'))
  })

  it('opens an existing file, and clears the dimming once it turns up', async () => {
    const exists = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const open = mount(exists)
    const link = screen.getByRole('button', { name: 'src/nope.ts' })
    await userEvent.click(link)
    await waitFor(() => expect(link).toHaveAttribute('data-missing', 'true'))

    await userEvent.click(link)
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('src/nope.ts', {
        line: undefined,
        background: false,
      })
    )
    expect(link).not.toHaveAttribute('data-missing')
  })

  it('opens straight away on a surface with no existence check', async () => {
    const open = mount(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'src/nope.ts' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(toast.info).not.toHaveBeenCalled()
  })
})
