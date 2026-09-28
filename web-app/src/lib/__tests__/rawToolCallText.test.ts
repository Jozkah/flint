import { expect, it } from 'vitest'
import { explainRawToolCall } from '../rawToolCallText'

it('replaces plain text tool markup with an honest failure notice', () => {
  const text = 'Sure, let me check.\n\n<tool_call> <function=shell_run> <parameter=command> pwd </parameter> </function>\n</tool_call>'
  expect(explainRawToolCall(text)).toBe(
    'Sure, let me check.\n\nTool call was emitted as text. No tool ran. Select a model with working tool support and try again.'
  )
})

it('leaves ordinary text alone', () => {
  expect(explainRawToolCall('Tool finished.')).toBe('Tool finished.')
})
