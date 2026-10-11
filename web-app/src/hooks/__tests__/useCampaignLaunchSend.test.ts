import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { useCampaignLaunchSend } from '../useCampaignLaunchSend'
import { useCampaignLaunch } from '@/lib/campaignStart'
import { usePrompt } from '@/hooks/usePrompt'

beforeEach(() => {
  useCampaignLaunch.setState({ pending: {} })
  usePrompt.getState().setPrompt('')
})

describe('campaign opening message', () => {
  it('is sent once through submit when the session is idle, and clears the composer copy', () => {
    const submit = vi.fn()
    usePrompt.getState().setPrompt('open me')
    useCampaignLaunch.getState().request('s1', 'open me')
    renderHook(() =>
      useCampaignLaunchSend({ sessionId: 's1', running: false, submit })
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toBe('open me')
    expect(usePrompt.getState().prompt).toBe('')
    expect(useCampaignLaunch.getState().pending).toEqual({})
  })

  it('waits for the session to be in view and idle', () => {
    const submit = vi.fn()
    useCampaignLaunch.getState().request('s1', 'goal')
    const { rerender } = renderHook(
      (p: { sessionId: string; running: boolean }) =>
        useCampaignLaunchSend({ ...p, submit }),
      { initialProps: { sessionId: 's0', running: false } }
    )
    expect(submit).not.toHaveBeenCalled()
    rerender({ sessionId: 's1', running: true })
    expect(submit).not.toHaveBeenCalled()
    rerender({ sessionId: 's1', running: false })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('gives the text back to the composer when the send is refused', () => {
    const submit = vi.fn((_t: string, refused: () => void) => refused())
    useCampaignLaunch.getState().request('s1', 'goal text')
    renderHook(() =>
      useCampaignLaunchSend({ sessionId: 's1', running: false, submit })
    )
    expect(usePrompt.getState().prompt).toBe('goal text')
  })

  it('a request made after mount is picked up', () => {
    const submit = vi.fn()
    renderHook(() =>
      useCampaignLaunchSend({ sessionId: 's1', running: false, submit })
    )
    act(() => useCampaignLaunch.getState().request('s1', 'late'))
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
