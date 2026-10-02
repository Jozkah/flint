import { describe, it, expect } from 'vitest'
import {
  getDefaultNotificationPosition,
  getToastOffset,
  getToastOffsetAvoidingPane,
  isNotificationPosition,
} from '../toastPlacement'

/**
 * Platform flags come from Vite `define` (compile-time). Vitest uses non-Tauri / non-Windows.
 */
describe('toastPlacement', () => {
  describe('getDefaultNotificationPosition', () => {
    it('returns top-right when not Windows Tauri (vitest env)', () => {
      expect(getDefaultNotificationPosition()).toBe('top-right')
    })
  })

  describe('getToastOffset', () => {
    it('uses base margin for top-right when not Tauri', () => {
      expect(getToastOffset('top-right')).toEqual({ top: 8, right: 8 })
    })

    it('uses base margin for corners when not Tauri', () => {
      expect(getToastOffset('top-left')).toEqual({ top: 8, left: 8 })
      expect(getToastOffset('bottom-right')).toEqual({ bottom: 8, right: 8 })
      expect(getToastOffset('bottom-left')).toEqual({ bottom: 8, left: 8 })
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
        top: 8,
        right: 416,
      })
      expect(getToastOffsetAvoidingPane('bottom-right', side, vp)).toEqual({
        bottom: 8,
        right: 416,
      })
    })

    it('leaves left positions alone', () => {
      expect(getToastOffsetAvoidingPane('top-left', side, vp)).toEqual({
        top: 8,
        left: 8,
      })
    })

    it('moves for a PIP only near the edge the toasts stack from', () => {
      const pip = {
        surface: 'pip' as const,
        rect: { left: 700, top: 440, right: 1184, bottom: 784 },
      }
      expect(getToastOffsetAvoidingPane('top-right', pip, vp)).toEqual({
        top: 8,
        right: 8,
      })
      expect(getToastOffsetAvoidingPane('bottom-right', pip, vp)).toEqual({
        bottom: 8,
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
