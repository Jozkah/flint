import { expect, it } from 'vitest'
import { explainRawToolCall, hasRawToolCall } from '../rawToolCallText'

it('replaces plain text tool markup with an honest failure notice', () => {
  const text =
    'Sure, let me check.\n\n<tool_call> <function=shell_run> <parameter=command> pwd </parameter> </function>\n</tool_call>'
  expect(explainRawToolCall(text)).toBe(
    'Sure, let me check.\n\nTool call was emitted as text. No tool ran. Check this model’s tool support and try again.'
  )
  expect(hasRawToolCall(text)).toBe(true)
})

it('leaves ordinary text alone', () => {
  expect(explainRawToolCall('Tool finished.')).toBe('Tool finished.')
  expect(hasRawToolCall('Tool finished.')).toBe(false)
})
