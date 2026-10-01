import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { codeRefToken, contextPct } from '../ui/format'
import { PreviewTab } from '../shell/panels'
import { resetApp, useFixtures } from './helpers'

beforeEach(() => resetApp())

describe('known gaps', () => {
  it('the Cowork ring shows the real share of the window', () => {
    expect(contextPct({ usedTokens: 32_000, windowTokens: 128_000 })).toBe(25)
    expect(contextPct({ usedTokens: 10, windowTokens: null })).toBe(0)
    expect(contextPct(undefined)).toBe(0)
  })

  it('Add to chat uses the desktop reference form', () => {
    expect(codeRefToken('src/a.ts', 9, 3)).toBe('@src/a.ts:3-9')
    expect(codeRefToken('src/a.ts', 4, 4)).toBe('@src/a.ts:4')
  })

  it('the live preview loads through a ticket, sandboxed without same-origin', async () => {
    useFixtures({
      'cowork.preview': { artifacts: [], path: null, kind: null, content: null, live: { url: 'http://localhost:5173/' } },
      'preview.ticket': { path: '/remote/v1/preview/tk/' },
    })
    render(<PreviewTab id="w1" />)
    const frame = (await screen.findByTestId('live-frame')) as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('/remote/v1/preview/tk/')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('without a live preview the notice stays', async () => {
    useFixtures({ 'cowork.preview': { artifacts: [], path: null, kind: null, content: null } })
    render(<PreviewTab id="w1" />)
    await waitFor(() => expect(screen.getByText(/Nothing to preview yet/)).toBeTruthy())
  })
})
