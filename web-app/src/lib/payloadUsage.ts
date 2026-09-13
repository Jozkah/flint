/**
 * What the payload that was actually dispatched cost. AH-073.
 *
 * Jan's own measurement runs before a request exists and is bytes over four:
 * useful for planning, never a count. The exact number comes back from the
 * server that tokenized the payload, and this is where it is bound to the
 * invocation and the snapshot it belongs to -- a run makes many model calls,
 * and a count shown beside the wrong payload looks authoritative while being
 * wrong.
 */
import { invoke } from '@tauri-apps/api/core'
import type { PromptSnapshotRef } from '@/lib/providerFetch'

export type UsageSource = 'provider' | 'estimated'

export type PayloadUsage = {
  v: number
  at: string
  session: string
  run: string
  invocation: string
  snapshot: string
  snapshot_hash: string
  model: string
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  source: UsageSource
}

export type ProviderUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
} | null

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null

/**
 * Record one dispatch's accounting, best effort.
 *
 * Never rejects and never throws: a run must not fail because its accounting
 * line could not be written, and a caller should not have to guard it. Outside
 * Tauri there is nowhere to write and this is a no-op. Resolves `true` only
 * when the backend accepted the record.
 */
export async function recordPayloadUsage(input: {
  session: string
  run: string
  snapshot: PromptSnapshotRef | null
  model?: string
  usage: ProviderUsage
}): Promise<boolean> {
  const invocation = input.snapshot?.invocation ?? ''
  // Without an invocation there is nothing to bind the count to, and an
  // unbound count is exactly what this record exists to stop.
  if (!invocation) return false

  try {
    await invoke('payload_usage_record', {
      usage: {
        v: 1,
        at: new Date().toISOString(),
        session: input.session,
        run: input.run,
        invocation,
        snapshot: input.snapshot?.id ?? '',
        snapshot_hash: input.snapshot?.hash ?? '',
        model: input.model ?? '',
        prompt_tokens: positive(input.usage?.prompt_tokens),
        completion_tokens: positive(input.usage?.completion_tokens),
        total_tokens: positive(input.usage?.total_tokens),
        // Only what the provider counted is called a count.
        source: input.usage ? 'provider' : 'estimated',
      } satisfies PayloadUsage,
    })
    return true
  } catch {
    // Reported by the backend; never fatal here.
    return false
  }
}

/** Accounting for one invocation, run or session. Scoped like snapshots. */
export async function lookupPayloadUsage(scope: {
  invocation?: string
  run?: string
  session?: string
}): Promise<PayloadUsage[]> {
  if (!scope.invocation && !scope.run && !scope.session) return []
  try {
    const found = await invoke<PayloadUsage[]>('payload_usage_lookup', {
      invocation: scope.invocation ?? null,
      run: scope.run ?? null,
      session: scope.session ?? null,
    })
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}
