import { beforeEach, expect, it } from 'vitest'
import {
  forgetAllServerLimits,
  reconcileServerLimit,
  rememberServerLimit,
  serverReportedLimit,
} from '../contextLimitRecovery'

const binding = { provider: 'llamacpp', baseUrl: 'http://127.0.0.1:8080', model: 'qwen3' }
const refusal = { contextTokens: 8192, requestTokens: 9000, via: 'known-message' as const }

beforeEach(() => forgetAllServerLimits())

it('forgets a learned window once the reloaded server reports a different one', () => {
  // llama-server -c 8192 refused; it reports 8192 too.
  rememberServerLimit(binding, refusal)
  expect(reconcileServerLimit(binding, 8192)?.contextTokens).toBe(8192)
  // Reloaded with -c 32768: the stale 8192 must not outrank it.
  expect(reconcileServerLimit(binding, 32768)).toBeNull()
  expect(serverReportedLimit(binding)).toBeNull()
})

it('keeps the learned window while the reported one is unchanged', () => {
  // A provider listing 262,144 for a server running at 200,000.
  rememberServerLimit(binding, { ...refusal, contextTokens: 200000, requestTokens: 205640 })
  expect(reconcileServerLimit(binding, 262144)?.contextTokens).toBe(200000)
  expect(reconcileServerLimit(binding, 262144)?.contextTokens).toBe(200000)
})

it('does not treat a runtime that has not answered yet as a change', () => {
  rememberServerLimit(binding, refusal)
  expect(reconcileServerLimit(binding, 8192)?.contextTokens).toBe(8192)
  expect(reconcileServerLimit(binding, null)?.contextTokens).toBe(8192)
  expect(reconcileServerLimit(binding, 8192)?.contextTokens).toBe(8192)
})
