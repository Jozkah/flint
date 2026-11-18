import { describe, expect, it } from 'vitest'
import { artifactsOfChatMessages } from '../linkedChatArtifacts'
import { memoryLocation } from '../memoryBinding'

describe('artifactsOfChatMessages', () => {
  it('returns nothing for a chat with no write calls', () => {
    expect(artifactsOfChatMessages([])).toEqual([])
  })
})

describe('memoryLocation with a linked group', () => {
  it('carries the linked id beside the folder, and omits it when unlinked', () => {
    const linked = memoryLocation('D', { projectRoot: 'F', linkedJanProjectId: 'h1' }, 's')
    expect(linked).toMatchObject({ projectRoot: 'F', linkedJanProjectId: 'h1', sessionId: 's' })
    expect(memoryLocation('D', { projectRoot: 'F' }, 's')).not.toHaveProperty('linkedJanProjectId')
  })
})
