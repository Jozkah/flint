import { describe, expect, it } from 'vitest'
import { roomDetailOf } from '../details'
import type { Room } from '@/lib/rooms/types'
import { DEFAULT_ROOM_LIMITS } from '@/lib/rooms/types'

describe('mobile room detail', () => {
  it('exposes persisted participant reasoning and moderator provider/model', () => {
    const room = {
      v: 1,
      id: 'r-mobile',
      title: 'Architecture review',
      objective: 'Choose an approach',
      status: 'paused',
      mode: 'round-robin',
      moderator: {
        enabled: true,
        name: 'Moderator',
        model: { provider: 'anthropic', id: 'claude-sonnet' },
      },
      participants: [
        {
          id: 'p1',
          name: 'Reviewer',
          role: 'reviewer',
          model: { provider: 'openai', id: 'gpt-5' },
          toolAccess: 'none',
          reasoning: { mode: 'on', level: 'high' },
          removed: false,
          order: 0,
          availability: { state: 'unknown' },
        },
      ],
      limits: DEFAULT_ROOM_LIMITS,
      usage: {
        turns: 0,
        rounds: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimated: false,
        costUsd: null,
        activeMs: 0,
        consecutiveRepetitive: 0,
      },
      round: 0,
      spokenThisRound: [],
      nextSpeakerId: 'p1',
      stopReason: null,
      rev: 1,
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Room

    const detail = roomDetailOf(room)
    expect(detail.participants[0].reasoning).toEqual({ mode: 'on', level: 'high' })
    expect(detail.moderator).toMatchObject({
      enabled: true,
      model: 'claude-sonnet',
      provider: 'anthropic',
    })
  })
})
