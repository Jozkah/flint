import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { UIMessage } from 'ai'
import { ConversationFindBar } from '../ConversationFindBar'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const messages = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'alpha beta' }] },
  { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'beta gamma beta' }] },
] as unknown as UIMessage[]

let host: HTMLDivElement
const scrolled: string[] = []

beforeEach(() => {
  scrolled.length = 0
  host = document.createElement('div')
  host.innerHTML =
    '<div data-message-id="m1"><p>alpha beta</p></div><div data-message-id="m2"><p>beta gamma beta</p></div>'
  document.body.appendChild(host)
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this.closest('[data-message-id]') as HTMLElement).dataset.messageId!)
  }
})

const renderBar = (onClose = vi.fn()) =>
  render(<ConversationFindBar messages={messages} root={() => host} onClose={onClose} />)
const input = () => screen.getByTestId('conversation-find-input')
const count = () => screen.getByTestId('conversation-find-count').textContent

describe('ConversationFindBar', () => {
  it('counts matches and steps through them with Enter and Shift+Enter', () => {
    renderBar()
    fireEvent.change(input(), { target: { value: 'beta' } })
    expect(count()).toBe('1 / 3')
    expect(scrolled.at(-1)).toBe('m1')

    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(count()).toBe('2 / 3')
    expect(scrolled.at(-1)).toBe('m2')

    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(count()).toBe('1 / 3') // wraps

    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    expect(count()).toBe('3 / 3')
  })

  it('does not scroll again when only the streamed text changes', () => {
    const { rerender } = renderBar()
    fireEvent.change(input(), { target: { value: 'beta' } })
    const before = scrolled.length
    const streamed = [
      messages[0],
      { ...messages[1], parts: [{ type: 'text', text: 'beta gamma beta delta' }] },
    ] as unknown as UIMessage[]
    rerender(
      <ConversationFindBar messages={streamed} root={() => host} onClose={vi.fn()} />
    )
    expect(scrolled.length).toBe(before)
    expect(count()).toBe('1 / 3')
  })

  it('counts what is on screen, not markdown syntax in the raw text', () => {
    host.innerHTML =
      '<div data-message-id="m1"><p><strong>star</strong> and star</p></div>'
    const md = [
      { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: '**star** and star' }] },
    ] as unknown as UIMessage[]
    render(<ConversationFindBar messages={md} root={() => host} onClose={vi.fn()} />)
    fireEvent.change(input(), { target: { value: '**' } })
    expect(count()).toBe('chat:find.none')
    fireEvent.change(input(), { target: { value: 'star' } })
    expect(count()).toBe('1 / 2')
  })

  it('says when nothing matches and closes on Escape', () => {
    const onClose = vi.fn()
    renderBar(onClose)
    fireEvent.change(input(), { target: { value: 'zzz' } })
    expect(count()).toBe('chat:find.none')
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
