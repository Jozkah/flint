type PickerState<M extends { id: string }> = {
  selectedProvider: string
  selectedModel: M | null | undefined
  providers: Array<{ provider: string; active?: boolean; models: M[] }>
}

export type CoworkModelChoice<M extends { id: string }> = {
  /** The provider and model a run sends with, or null when there is none. */
  choice: ThreadModel | null
  /** The model entry `choice` names, found among the active providers. */
  model: M | null
  /**
   * The session's saved model when it no longer resolves (provider removed or
   * disabled, model gone). Set whether or not a fallback was found.
   */
  unavailable: ThreadModel | null
  /**
   * The choice differs from what the session saved and should be written
   * back: the session had no model, or its saved one no longer resolves and
   * the picker's model stands in for it.
   */
  save: boolean
}

function find<M extends { id: string }>(
  providers: PickerState<M>['providers'],
  choice: ThreadModel | null | undefined
): M | null {
  if (!choice?.id || !choice.provider) return null
  return (
    providers
      .find((p) => p.provider === choice.provider && p.active !== false)
      ?.models.find((m) => m.id === choice.id) ?? null
  )
}

/**
 * The model a Cowork session sends with: its own saved choice, or the
 * picker's when it has none. A saved choice that no longer resolves falls
 * back to the picker's model, when that one resolves, and is reported so the
 * caller can save the replacement and say which model went missing.
 *
 * The composer's "is a model chosen" check and the run itself both use this,
 * so the two cannot disagree.
 */
export function resolveCoworkModel<M extends { id: string }>(
  saved: ThreadModel | null | undefined,
  picker: PickerState<M>
): CoworkModelChoice<M> {
  const pickerChoice: ThreadModel | null = picker.selectedModel
    ? { provider: picker.selectedProvider, id: picker.selectedModel.id }
    : null
  const pickerModel = find(picker.providers, pickerChoice)
  if (saved?.id && saved.provider) {
    const model = find(picker.providers, saved)
    if (model) return { choice: saved, model, unavailable: null, save: false }
    if (pickerModel) {
      return {
        choice: pickerChoice,
        model: pickerModel,
        unavailable: saved,
        save: true,
      }
    }
    return { choice: saved, model: null, unavailable: saved, save: false }
  }
  return {
    choice: pickerChoice,
    model: pickerModel,
    unavailable: null,
    save: Boolean(pickerChoice),
  }
}
