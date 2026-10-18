import { beforeEach, describe, expect, it } from 'vitest'
import {
  isCodeBlockExpanded,
  resetCodeBlockExpandCache,
  setCodeBlockExpanded,
} from '../codeBlockExpand'

describe('codeBlockExpand', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetCodeBlockExpandCache()
  })
  it('remembers an expanded block for the session', () => {
    expect(isCodeBlockExpanded('m1:0')).toBe(false)
    setCodeBlockExpanded('m1:0', true)
    resetCodeBlockExpandCache()
    expect(isCodeBlockExpanded('m1:0')).toBe(true)
    expect(isCodeBlockExpanded('m1:1')).toBe(false)
  })
  it('forgets a collapsed block', () => {
    setCodeBlockExpanded('m1:0', true)
    setCodeBlockExpanded('m1:0', false)
    resetCodeBlockExpandCache()
    expect(isCodeBlockExpanded('m1:0')).toBe(false)
  })
})
