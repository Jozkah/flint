/**
 * "Installed skills changed": raised when a skill is written or deleted through
 * the app, so caches of the model-facing list and of skill instructions (kept
 * elsewhere, and importing the store) can drop what they hold without the
 * store having to know about them.
 */
const listeners = new Set<() => void>()

export function onSkillsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifySkillsChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One listener failing must not stop the others.
    }
  }
}
