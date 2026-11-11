/**
 * Ends a run whose request compaction cannot make fit. The runner's compaction
 * guard swallows other compaction failures; this one it passes through, so the
 * run ends on this message instead of resending a request just refused.
 */
export class UnfittableRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnfittableRequestError'
  }
}

export function isUnfittableRequest(e: unknown): e is UnfittableRequestError {
  return e instanceof UnfittableRequestError
}
