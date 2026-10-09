import { describe, expect, it } from 'vitest'
import { CustomChatTransport } from '@/lib/custom-chat-transport'

// An MCP image in a tool result must reach every provider as an image part (or
// a short note), not as base64 text, so chat hoists tool images by default.
describe('chat tool image hoisting', () => {
  it('is on for every provider by default', () => {
    const hoists = (
      CustomChatTransport.prototype as unknown as {
        hoistsToolImages(): boolean
      }
    ).hoistsToolImages
    expect(hoists.call({})).toBe(true)
  })
})
