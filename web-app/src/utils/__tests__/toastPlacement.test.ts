import { describe, it, expect } from 'vitest'
import {
  getDefaultNotificationPosition,
  getDialogToastPlacement,
  getToastOffset,
  getToastOffsetAvoidingPane,
  isNotificationPosition,
} from '../toastPlacement'

/**
 * Platform flags come from Vite `define` (compile-time). Vitest uses non-Tauri / non-Windows.
 */
describe('toastPlacement', () => {
  describe('getDefaultNotificationPosition', () => {
    it('defaults to bottom-right, away from the header controls', () => {
      expect(getDefaultNotificationPosition()).toBe('bottom-right')
    })
  })

  describe('getToastOffset', () => {
    it('clears the 52px top header for top-right', () => {
      expect(getToastOffset('top-right')).toEqual({ top: 60, right: 8 })
    })

    it('clears the header at the top and the composer dock (+ safe area) at the bottom', () => {
      expect(getToastOffset('top-left')).toEqual({ top: 60, left: 8 })
      expect(getToastOffset('bottom-right')).toEqual({ bottom: 'calc(164px + env(safe-area-inset-bottom, 0px))', right: 16 })
      expect(getToastOffset('bottom-left')).toEqual({ bottom: 'calc(164px + env(safe-area-inset-bottom, 0px))', left: 16 })
    })
  })

  describe('getToastOffsetAvoidingPane', () => {
    const vp = { width: 1200, height: 800 }
    const side = {
      surface: 'side' as const,
      rect: { left: 800, top: 0, right: 1200, bottom: 800 },
    }

    it('is the plain offset with no pane', () => {
      expect(getToastOffsetAvoidingPane('top-right', null, vp)).toEqual(
        getToastOffset('top-right')
      )
    })

    it('moves right positions left of the docked pane plus a gap', () => {
      expect(getToastOffsetAvoidingPane('top-right', side, vp)).toEqual({
        top: 60,
        right: 416,
      })
      expect(getToastOffsetAvoidingPane('bottom-right', side, vp)).toEqual({
        bottom: 'calc(164px + env(safe-area-inset-bottom, 0px))',
        right: 416,
      })
    })

    it('leaves left positions alone', () => {
      expect(getToastOffsetAvoidingPane('top-left', side, vp)).toEqual({
        top: 60,
        left: 8,
      })
    })

    it('moves for a PIP only near the edge the toasts stack from', () => {
      const pip = {
        surface: 'pip' as const,
        rect: { left: 700, top: 440, right: 1184, bottom: 784 },
      }
      expect(getToastOffsetAvoidingPane('top-right', pip, vp)).toEqual({
        top: 60,
        right: 8,
      })
      expect(getToastOffsetAvoidingPane('bottom-right', pip, vp)).toEqual({
        bottom: 'calc(164px + env(safe-area-inset-bottom, 0px))',
        right: 516,
      })
    })
  })

  describe('isNotificationPosition', () => {
    it('accepts corners only', () => {
      expect(isNotificationPosition('bottom-right')).toBe(true)
      expect(isNotificationPosition('top-center')).toBe(false)
    })
  })
})

describe('getDialogToastPlacement', () => {
  it('uses bottom-right on wide screens', () => {
    expect(getDialogToastPlacement(1100).position).toBe('bottom-right')
  })
  it('uses full-width bottom-center above the composer when narrow', () => {
    const p = getDialogToastPlacement(480)
    expect(p.position).toBe('bottom-center')
    expect(p.offset).toMatchObject({
      bottom: 'calc(164px + env(safe-area-inset-bottom, 0px))',
      left: '12px',
      right: '12px',
    })
  })
  it('treats exactly 640 as narrow', () => {
    expect(getDialogToastPlacement(640).position).toBe('bottom-center')
  })
})

describe('composerClearanceFor', () => {
  it('puts toasts in the very corner', async () => {
    const { composerClearanceFor } = await import('../toastPlacement')
    expect(composerClearanceFor()).toBe(16)
    expect(composerClearanceFor()).toBe(16)
    expect(composerClearanceFor()).toBe(16)
  })
})
