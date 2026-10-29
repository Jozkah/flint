// One-command review of the current diff, for the desktop Changes panel.
//
// The Rust side owns what a review *is*: it collects the diff, builds the
// reviewer and verifier prompts from the shipped roles and `REVIEW.md`, parses
// replies, and ranks. This module only makes the model calls (no tools, through
// the same utility-call path titles and summaries use) and sequences the
// passes, mirroring `review_diff` in `src-tauri/src/core/agent/review.rs`.

import { invokeCommand as invoke } from '@/lib/backend'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ModelFactory } from '@/lib/model-factory'
import { runUtilityAgent } from '@/lib/utilityAgents'

export type ReviewSeverity = 'high' | 'medium' | 'low'

export interface ReviewFinding {
  severity: ReviewSeverity
  file: string
  line: number | null
  problem: string
  fix: string
  /** `confirmed`, or `unverified` when the refute pass gave no answer. */
  verdict: string | null
}

export interface DiffReviewResult {
  findings: ReviewFinding[]
  /** Findings the second pass disproved and dropped. */
  refuted: number
  truncated: boolean
  files: number
}

interface ReviewPrompt {
  system: string
  user: string
}

interface ReviewPrepared {
  input: { files: string[]; truncated: boolean } & Record<string, unknown>
  prompt: ReviewPrompt
}

/** Most findings put through the refute pass (same cap as the CLI). */
export const MAX_VERIFIED = 20

export interface RunReviewOptions {
  folder: string
  sessionId: string
  base?: string
  security?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export async function runDiffReview(
  opts: RunReviewOptions
): Promise<DiffReviewResult> {
  const state = useModelProvider.getState()
  const providerName = state.selectedProvider
  const modelId = state.selectedModel?.id
  const provider = providerName ? state.getProviderByName(providerName) : undefined
  if (!provider || !modelId) throw new Error('no model is selected')
  const model = await ModelFactory.createModel(modelId, provider, {})

  const ask = (prompt: ReviewPrompt, maxOutputTokens: number) =>
    runUtilityAgent({
      kind: 'classify',
      session: opts.sessionId,
      model,
      modelId,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxOutputTokens,
      abortSignal: opts.signal,
      maxRetries: 1,
    })

  const prepared = await invoke<ReviewPrepared>('agent_review_prepare', {
    project: opts.folder,
    base: opts.base ?? null,
    security: opts.security ?? false,
  })
  const reply = await ask(prepared.prompt, 6000)
  const candidates = await invoke<ReviewFinding[]>('agent_review_parse', { reply })

  const kept: ReviewFinding[] = []
  let refuted = 0
  const total = Math.min(candidates.length, MAX_VERIFIED)
  for (const [i, finding] of candidates.entries()) {
    let confirmed: boolean | null = null
    if (i < MAX_VERIFIED) {
      opts.onProgress?.(i, total)
      try {
        const prompt = await invoke<ReviewPrompt>('agent_review_verify_prompt', {
          input: prepared.input,
          finding,
        })
        confirmed = await invoke<boolean | null>('agent_review_verdict', {
          reply: await ask(prompt, 600),
        })
      } catch (e) {
        // A cancelled review stops; a flaky second call leaves the finding
        // unverified rather than losing a real defect.
        if (opts.signal?.aborted) throw e
      }
    }
    if (confirmed === false) {
      refuted += 1
      continue
    }
    kept.push({ ...finding, verdict: confirmed ? 'confirmed' : 'unverified' })
  }
  const findings = await invoke<ReviewFinding[]>('agent_review_rank', {
    findings: kept,
  })
  return {
    findings,
    refuted,
    truncated: prepared.input.truncated,
    files: prepared.input.files.length,
  }
}

/** The task text that asks an agent session to fix these findings. */
export const reviewFixTask = (findings: ReviewFinding[]) =>
  invoke<string>('agent_review_fix_task', { findings })
