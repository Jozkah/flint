/**
 * A chat is bound to the provider it was started on (or that the user last
 * picked in it). Its messages go to that provider and no other: two providers
 * can serve a model with the same id, and silently answering from the other
 * one sends the conversation somewhere the user never chose.
 *
 * Only the user moves a chat to another provider, by picking a model in it.
 * When the bound provider is turned off or gone, nothing is sent until they
 * turn it back on or pick another model.
 */

type BoundModel = { id?: string; provider?: string } | null | undefined

type ProviderLike = { provider: string; active?: boolean }

export type BindingProblem =
  /** The chat's provider is switched off in Settings. */
  | { reason: 'provider-off'; provider: string }
  /** The model about to answer is on another provider than the chat's. */
  | { reason: 'other-provider'; provider: string; selected: string }

/** The provider a chat is bound to, when it has one. */
export function boundProvider(model: BoundModel): string | null {
  return model?.id && model.provider ? model.provider : null
}

/** Whether the chat's own provider is present but switched off. */
export function boundProviderOff(
  model: BoundModel,
  lookup: (name: string) => ProviderLike | undefined
): string | null {
  const name = boundProvider(model)
  if (!name) return null
  return lookup(name)?.active === false ? name : null
}

/**
 * Why a request for this chat must not go to `selectedProvider`, or null when
 * it may. A chat with no bound model (a new one) takes whatever is selected.
 */
export function bindingProblem(
  model: BoundModel,
  selectedProvider: string | null | undefined,
  lookup: (name: string) => ProviderLike | undefined
): BindingProblem | null {
  const name = boundProvider(model)
  if (!name) return null
  if (lookup(name)?.active === false) return { reason: 'provider-off', provider: name }
  if (selectedProvider && selectedProvider !== name) {
    return { reason: 'other-provider', provider: name, selected: selectedProvider }
  }
  return null
}

/** Raised by the chat transport instead of sending to the wrong provider. */
export class ProviderBindingError extends Error {
  readonly problem: BindingProblem
  constructor(problem: BindingProblem, message: string) {
    super(message)
    this.name = 'ProviderBindingError'
    this.problem = problem
  }
}
