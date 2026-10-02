import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BrowserDomainDialog } from '../BrowserDomainDialog'
import {
  useBrowserAgentPrompt,
  type DomainAnswer,
} from '@/hooks/useBrowserAgentPrompt'

const ask = (
  over: Partial<{ url: string; host: string; tool: string; origin: string }> = {}
) => {
  let answer: DomainAnswer | undefined
  const done = useBrowserAgentPrompt
    .getState()
    .request({
      url: 'https://www.example.com/search?q=secret-token&x=1',
      host: 'www.example.com',
      tool: 'browser_open',
      ...over,
    })
    .then((a) => (answer = a))
  return { done, get: () => answer }
}

describe('BrowserDomainDialog', () => {
  beforeEach(() => {
    useBrowserAgentPrompt.setState({ queue: [] })
  })

  it('renders nothing while there is no question', () => {
    render(<BrowserDomainDialog />)
    expect(screen.queryByTestId('browser-domain-dialog')).toBeNull()
  })

  it('shows the host and the whole address, query string included', async () => {
    render(<BrowserDomainDialog />)
    ask()
    expect(await screen.findByTestId('browser-domain-dialog')).toBeTruthy()
    expect(screen.getByTestId('browser-domain-url').textContent).toBe(
      'https://www.example.com/search?q=secret-token&x=1'
    )
    expect(screen.getByRole('dialog').textContent).toContain('www.example.com')
  })

  it('Allow answers with the chosen scope', async () => {
    render(<BrowserDomainDialog />)
    const q = ask()
    await screen.findByTestId('browser-domain-dialog')
    // Default is the narrowest scope.
    fireEvent.click(screen.getByTestId('browser-domain-allow'))
    await q.done
    expect(q.get()).toEqual({ decision: 'allow', scope: 'once', subdomains: false })
    expect(screen.queryByTestId('browser-domain-dialog')).toBeNull()
  })

  it('carries the session / always choice and the subdomain box', async () => {
    render(<BrowserDomainDialog />)
    const q = ask()
    await screen.findByTestId('browser-domain-dialog')
    fireEvent.click(screen.getByTestId('browser-domain-scope-always'))
    fireEvent.click(screen.getByTestId('browser-domain-subdomains'))
    fireEvent.click(screen.getByTestId('browser-domain-allow'))
    await q.done
    expect(q.get()).toEqual({ decision: 'allow', scope: 'always', subdomains: true })
  })

  it('Not now declines and Never blocks', async () => {
    render(<BrowserDomainDialog />)
    const a = ask()
    await screen.findByTestId('browser-domain-dialog')
    fireEvent.click(screen.getByTestId('browser-domain-deny'))
    await a.done
    expect(a.get()?.decision).toBe('deny')

    const b = ask()
    await screen.findByTestId('browser-domain-dialog')
    fireEvent.click(screen.getByTestId('browser-domain-never'))
    await b.done
    expect(b.get()?.decision).toBe('never')
  })

  it('Escape counts as a no', async () => {
    render(<BrowserDomainDialog />)
    const q = ask()
    const dialog = await screen.findByTestId('browser-domain-dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await q.done
    expect(q.get()?.decision).toBe('deny')
  })

  it('asks one at a time, in order, and says how many wait', async () => {
    render(<BrowserDomainDialog />)
    const first = ask({ host: 'a.test', url: 'https://a.test/' })
    const second = ask({ host: 'b.test', url: 'https://b.test/' })
    await screen.findByTestId('browser-domain-dialog')
    expect(screen.getByTestId('browser-domain-url').textContent).toBe('https://a.test/')
    expect(screen.getByRole('dialog').textContent).toContain('browser-agent:domain.more')
    fireEvent.click(screen.getByTestId('browser-domain-deny'))
    await first.done
    await act(async () => {})
    expect(screen.getByTestId('browser-domain-url').textContent).toBe('https://b.test/')
    fireEvent.click(screen.getByTestId('browser-domain-allow'))
    await second.done
    expect(second.get()?.decision).toBe('allow')
  })

  it('offers no subdomain option for an IP address', async () => {
    render(<BrowserDomainDialog />)
    ask({ host: '93.184.216.34', url: 'http://93.184.216.34/' })
    await screen.findByTestId('browser-domain-dialog')
    expect(screen.queryByTestId('browser-domain-subdomains')).toBeNull()
  })

  it('a withdrawn question (run stopped) disappears and counts as no', async () => {
    render(<BrowserDomainDialog />)
    const abort = new AbortController()
    let answer: DomainAnswer | undefined
    const done = useBrowserAgentPrompt
      .getState()
      .request({
        url: 'https://a.test/',
        host: 'a.test',
        tool: 'browser_open',
        signal: abort.signal,
      })
      .then((a) => (answer = a))
    await screen.findByTestId('browser-domain-dialog')
    await act(async () => abort.abort())
    await done
    expect(answer?.decision).toBe('deny')
    expect(screen.queryByTestId('browser-domain-dialog')).toBeNull()
  })
})
