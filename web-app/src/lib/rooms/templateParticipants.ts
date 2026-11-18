/** A participant a template seeds: a name, a role and the model it speaks as. */
export type TemplateParticipant = {
  name: string
  role: string
  model: { provider: string; id: string }
}

/** The model the user has selected in the app, whichever provider it is from. */
export type ActiveModel = { provider: string; id: string } | null

/**
 * Participants a room template starts with: one per name, each on the model
 * the user has selected. The provider is taken from the selection as it is, so
 * a model of a remote custom provider seeds the room like a local one does.
 * No selected model, no participants (the room still opens and asks for them).
 */
export function templateParticipants(
  names: readonly string[] | undefined,
  active: ActiveModel
): TemplateParticipant[] {
  if (!names || names.length === 0 || !active?.id || !active.provider) return []
  return names.map((name) => ({
    name,
    role: name,
    model: { provider: active.provider, id: active.id },
  }))
}
