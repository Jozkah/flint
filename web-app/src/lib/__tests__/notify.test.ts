import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowNotifications, notifyInBackground } from '../notify'

const shown: Array<[string, unknown]> = []

function fakeNotification(permission: NotificationPermission) {
  const ctor = vi.fn(function (this: unknown, title: string, options?: unknown) {
    shown.push([title, options])
  }) as unknown as typeof Notification & { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> }
  ctor.permission = permission
  ctor.requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
  vi.stubGlobal('Notification', ctor)
  return ctor
}

afterEach(() => {
  shown.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notifyInBackground', () => {
  it('stays quiet while the window is in front', () => {
    fakeNotification('granted')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(notifyInBackground('Image ready')).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it('shows one when the window is not in front', () => {
    fakeNotification('granted')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(notifyInBackground('Image ready', 'A lighthouse')).toBe(true)
    expect(shown).toEqual([['Image ready', { body: 'A lighthouse' }]])
  })

  it('does nothing without permission or without the API', () => {
    fakeNotification('denied')
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(notifyInBackground('x')).toBe(false)
    vi.stubGlobal('Notification', undefined)
    expect(notifyInBackground('x')).toBe(false)
  })
})

describe('allowNotifications', () => {
  it('asks only when the answer is still open', async () => {
    const asked = fakeNotification('default')
    await allowNotifications()
    expect(asked.requestPermission).toHaveBeenCalledTimes(1)
    const settled = fakeNotification('granted')
    await allowNotifications()
    expect(settled.requestPermission).not.toHaveBeenCalled()
  })
})
