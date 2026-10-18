import { beforeEach, describe, expect, it } from 'vitest'
import { usePrompt } from '../usePrompt'

const p = () => usePrompt.getState()

describe('per-chat main drafts (UI-005)', () => {
  beforeEach(() => usePrompt.setState({ prompt: '', stashed: {}, draftOwner: null }))

  it('a draft does not follow into another chat or New Chat', () => {
    p().switchDraft('a')
    p().setPrompt('half-written for A')
    p().switchDraft('b')
    expect(p().prompt).toBe('')
    p().switchDraft('__new__')
    expect(p().prompt).toBe('')
  })

  it("a chat gets its own unsent draft back", () => {
    p().switchDraft('a')
    p().setPrompt('draft A')
    p().switchDraft('b')
    p().setPrompt('draft B')
    p().switchDraft('a')
    expect(p().prompt).toBe('draft A')
    p().switchDraft('b')
    expect(p().prompt).toBe('draft B')
  })
})
