/**
 * "Apply all to folder": every file a Review only run left in its sandbox,
 * copied into the attached folder in one confirmed step.
 *
 * Built on the per-file path (`applySandboxFile`) and its backend checks; the
 * only new backend call is a dry run (`agent_sandbox_apply_probe`) that says,
 * under the same confinement, whether each destination is new, already
 * identical, or a different file that would be replaced.
 */
import { invoke } from '@tauri-apps/api/core'
import type {
  SandboxApplyOutcome,
  SandboxApplyPlan,
} from '@/lib/coworkSandboxApply'
import { toast } from 'sonner'
import { errorText } from '@/lib/errorText'

export type SandboxApplyProbe = 'new' | 'same' | 'differs'

export async function probeSandboxFile(input: {
  session: string
  path: string
  project: string
  destination?: string
}): Promise<SandboxApplyProbe> {
  return await invoke<SandboxApplyProbe>('agent_sandbox_apply_probe', input)
}

/** One file in the confirmation. */
export type ApplyAllEntry =
  | {
      kind: 'apply'
      path: string
      plan: SandboxApplyPlan
      /** 'differs': a different file is there and would be replaced. */
      probe: 'new' | 'differs'
      /** Ticked by default only when nothing would be overwritten. */
      checked: boolean
    }
  | {
      kind: 'skip'
      path: string
      plan: SandboxApplyPlan | null
      /** `not-in-sandbox`, `same`, or the backend's own words. */
      reason: 'not-in-sandbox' | 'same' | { message: string }
    }

/** Every file, planned and probed, in list order. Probes run one at a time. */
export async function planApplyAll(
  paths: readonly string[],
  planFor: (path: string) => SandboxApplyPlan | null,
  probe: (path: string, plan: SandboxApplyPlan) => Promise<SandboxApplyProbe>
): Promise<ApplyAllEntry[]> {
  const entries: ApplyAllEntry[] = []
  for (const path of paths) {
    const plan = planFor(path)
    if (!plan) {
      entries.push({ kind: 'skip', path, plan, reason: 'not-in-sandbox' })
      continue
    }
    try {
      const found = await probe(path, plan)
      entries.push(
        found === 'same'
          ? { kind: 'skip', path, plan, reason: 'same' }
          : { kind: 'apply', path, plan, probe: found, checked: found === 'new' }
      )
    } catch (e) {
      entries.push({ kind: 'skip', path, plan, reason: { message: errorText(e) } })
    }
  }
  return entries
}

export type ApplyAllResult =
  | { path: string; ok: true; outcome: 'created' | 'replaced' }
  /** Something appeared at the destination after the probe; left alone. */
  | { path: string; ok: false; conflict: true }
  | { path: string; ok: false; conflict?: false; message: string }

/**
 * Apply the ticked entries one after another. Only an entry the user ticked
 * knowing it replaces a file is applied with `overwrite`; any other that meets
 * an existing file is reported, not written.
 */
export async function runApplyAll(
  entries: readonly ApplyAllEntry[],
  apply: (path: string, overwrite: boolean) => Promise<SandboxApplyOutcome>,
  onResult?: (result: ApplyAllResult) => void
): Promise<ApplyAllResult[]> {
  const results: ApplyAllResult[] = []
  for (const entry of entries) {
    if (entry.kind !== 'apply' || !entry.checked) continue
    let result: ApplyAllResult
    try {
      const outcome = await apply(entry.path, entry.probe === 'differs')
      result =
        outcome === 'exists'
          ? { path: entry.path, ok: false, conflict: true }
          : { path: entry.path, ok: true, outcome }
    } catch (e) {
      result = { path: entry.path, ok: false, message: errorText(e) }
    }
    results.push(result)
    onResult?.(result)
  }
  return results
}

/**
 * "Apply all automatically": only what creates a new file. A destination
 * that already differs is a conflict and is left for the user to decide.
 */
export function autoApplicable(entries: readonly ApplyAllEntry[]): {
  apply: ApplyAllEntry[]
  conflicts: ApplyAllEntry[]
} {
  const apply = entries.filter((e) => e.kind === 'apply' && e.probe === 'new')
  const conflicts = entries.filter(
    (e) => e.kind === 'apply' && e.probe === 'differs'
  )
  return {
    apply: apply.map((e) => ({ ...e, checked: true }) as ApplyAllEntry),
    conflicts,
  }
}

/** A toast that sums up one Apply all. */
export function toastApplyAll(
  results: readonly ApplyAllResult[],
  t: (key: string, vars?: Record<string, unknown>) => string
) {
  const applied = results.filter((r) => r.ok).length
  const failed = results.length - applied
  const text = t('common:changes.applyAllSummary', { applied, failed })
  if (failed > 0) toast.warning(text)
  else toast.success(text)
}
