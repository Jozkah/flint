import { create } from 'zustand'
import { AUTO_LANGUAGE } from '@/lib/translatePrompt'

type TranslateDraft = {
  source: string
  target: string
  input: string
  output: string
  setSource: (v: string) => void
  setTarget: (v: string) => void
  setInput: (v: string) => void
  setOutput: (v: string) => void
}

export const TRANSLATE_DRAFT_DEFAULTS = {
  source: AUTO_LANGUAGE,
  target: 'English',
  input: '',
  output: '',
}

/**
 * The translate page's working state, kept outside the component so leaving
 * the page and coming back does not wipe what the user typed or got.
 */
export const useTranslateDraft = create<TranslateDraft>()((set) => ({
  ...TRANSLATE_DRAFT_DEFAULTS,
  setSource: (source) => set({ source }),
  setTarget: (target) => set({ target }),
  setInput: (input) => set({ input }),
  setOutput: (output) => set({ output }),
}))
