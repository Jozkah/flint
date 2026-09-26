import { describe, expect, it } from 'vitest'
import roomPage from '../rooms/$roomId.tsx?raw'
import roomList from '../rooms/index.tsx?raw'

// In split view a room page sits in a pane narrower than the window, so its
// layout must follow the pane (container queries), not the viewport.
describe('room pages follow the pane width', () => {
  it.each([
    ['room page', roomPage, '@container/room'],
    ['room list', roomList, '@container/rooms'],
  ])('%s uses container queries, not viewport breakpoints', (_n, src, container) => {
    expect(src).toContain(container)
    expect(src).not.toMatch(/(^|[\s'"`])(max-)?(lg|xl|2xl):/m)
  })
})
