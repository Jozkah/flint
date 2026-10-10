/**
 * A downloaded model's id is the folder it lives in under the models directory,
 * so on Windows it reads `author\repo\file` while a Hugging Face repo id and the
 * ids Discover builds read `author/repo/file`. Compare the two through this.
 */
export function modelIdKey(id: string): string {
  return id.replace(/\\/g, '/')
}

/** The id the provider actually lists for `id`, or `id` when none matches. */
export function listedModelId(
  models: readonly { id: string }[] | undefined,
  id: string
): string {
  const key = modelIdKey(id)
  return models?.find((m) => modelIdKey(m.id) === key)?.id ?? id
}
