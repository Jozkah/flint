import { describe, expect, it } from 'vitest'
import { roomNavStatus } from '../navStatus'

describe('roomNavStatus', () => {
  it('is waiting while the room waits on the user', () => {
    expect(
      roomNavStatus({ status: 'awaiting-user', running: true, awaitingApproval: false })
    ).toBe('wait')
    expect(
      roomNavStatus({ status: 'awaiting-user', running: false, awaitingApproval: false })
    ).toBe('wait')
  })

  it('is waiting while a tool approval for the room is pending', () => {
    expect(
      roomNavStatus({ status: 'running', running: true, awaitingApproval: true })
    ).toBe('wait')
  })

  it('is active while running and nothing waits on the user', () => {
    expect(
      roomNavStatus({ status: 'running', running: true, awaitingApproval: false })
    ).toBe('active')
  })

  it('shows no mark for an idle room', () => {
    expect(
      roomNavStatus({ status: 'paused', running: false, awaitingApproval: false })
    ).toBe('none')
    expect(
      roomNavStatus({ status: 'completed', running: false, awaitingApproval: false })
    ).toBe('none')
  })
})
