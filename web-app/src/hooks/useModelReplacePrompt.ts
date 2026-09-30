import { create } from 'zustand'
import { modelKey, type ModelRef } from '@/lib/modelReplace'

type Request = {
  /** What the models are for, in the dialog's first line: "this room", "this chat". */
  subject: string
  missing: ModelRef[]
  resolve: (choices: Record<string, ModelRef> | null) => void
}

type State = {
  request: Request | null
  answer: (choices: Record<string, ModelRef> | null) => void
}

export const useModelReplacePrompt = create<State>((set, get) => ({
  request: null,
  answer: (choices) => {
    const current = get().request
    set({ request: null })
    current?.resolve(choices)
  },
}))

/**
 * Ask the user to pick a replacement for each model that can no longer be used.
 * Resolves with the choice for each (by `modelKey`), or null if they cancel. One
 * question at a time: a second call while one is open cancels the first.
 */
export function promptReplaceModels(
  subject: string,
  missing: ModelRef[]
): Promise<Record<string, ModelRef> | null> {
  if (missing.length === 0) return Promise.resolve({})
  return new Promise((resolve) => {
    useModelReplacePrompt.getState().request?.resolve(null)
    useModelReplacePrompt.setState({ request: { subject, missing, resolve } })
  })
}

export { modelKey }
