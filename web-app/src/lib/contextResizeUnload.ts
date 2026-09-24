/**
 * Unload a model so it reloads with an increased context size.
 *
 * Best effort: an engine may reject the unload because the model is not
 * loaded (MLX throws "No active MLX session found"). The new context size is
 * read on the next load either way, so the failure is logged and swallowed
 * instead of aborting the "Increase Context Size" flow and leaving the
 * context-limit banner stuck (#123).
 */
export async function unloadForContextResize(
  stopModel: (modelId: string) => Promise<unknown>,
  modelId: string
): Promise<void> {
  try {
    await stopModel(modelId)
  } catch (error) {
    console.warn(
      `Could not unload ${modelId} before increasing its context size`,
      error
    )
  }
}
