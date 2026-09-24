/**
 * Which llamacpp models still need an mmproj (vision) probe.
 *
 * A model that already has the `vision` capability has nothing to learn from
 * the probe, and one already probed in this dropdown session has already
 * answered. Everything else is probed once. Without this, every unrelated
 * providers-store update re-probed every model while the dropdown was open
 * (#83).
 */
export function modelsNeedingVisionProbe(
  models: ReadonlyArray<{ id: string; capabilities?: string[] }>,
  alreadyProbed: ReadonlySet<string>
): string[] {
  return models
    .filter(
      (m) =>
        !alreadyProbed.has(m.id) && !(m.capabilities ?? []).includes('vision')
    )
    .map((m) => m.id)
}
