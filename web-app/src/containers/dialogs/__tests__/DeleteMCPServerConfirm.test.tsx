import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) =>
      vars ? `${k}:${JSON.stringify(vars)}` : k,
  }),
}))

import DeleteMCPServerConfirm from '../DeleteMCPServerConfirm'

describe('DeleteMCPServerConfirm', () => {
  it('says what delete removes, what it keeps, and the alternative', () => {
    render(
      <DeleteMCPServerConfirm
        open
        onOpenChange={vi.fn()}
        serverName="github"
        onConfirm={vi.fn()}
      />
    )
    expect(
      screen.getByText(/mcp-servers:deleteServer\.description.*github/)
    ).toBeInTheDocument()
    expect(
      screen.getByText('mcp-servers:deleteServer.approvalsKept')
    ).toBeInTheDocument()
    expect(
      screen.getByText('mcp-servers:deleteServer.disableInstead')
    ).toBeInTheDocument()
  })

  it('confirms and closes', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <DeleteMCPServerConfirm
        open
        onOpenChange={onOpenChange}
        serverName="github"
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByText('mcp-servers:deleteServer.delete'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
