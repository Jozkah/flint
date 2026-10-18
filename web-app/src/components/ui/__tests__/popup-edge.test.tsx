import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

import {
  POPUP_COLLISION_PADDING,
  TOOLTIP_COLLISION_PADDING,
} from '@/components/ui/popup-edge'

// jsdom has no layout, so the guard checks what each primitive hands Radix:
// every floating surface must default to the shared edge margin.
const { seen, spy, Pass } = vi.hoisted(() => {
  const seen: Record<string, Record<string, unknown>> = {}
  const spy = (name: string) =>
    function Content(props: Record<string, unknown>) {
      seen[name] = props
      return props.children as React.ReactNode
    }
  const Pass = ({ children }: { children?: React.ReactNode }) => children
  return { seen, spy, Pass }
})

vi.mock('@radix-ui/react-dropdown-menu', async (orig) => ({
  ...(await orig<object>()),
  Portal: Pass,
  Content: spy('dropdown'),
  SubContent: spy('dropdown-sub'),
}))
vi.mock('radix-ui', async (orig) => {
  const mod = await orig<{ Popover: object }>()
  return {
    ...mod,
    Popover: { ...mod.Popover, Portal: Pass, Content: spy('popover') },
  }
})
vi.mock('@radix-ui/react-hover-card', async (orig) => ({
  ...(await orig<object>()),
  Portal: Pass,
  Content: spy('hover-card'),
}))
vi.mock('@radix-ui/react-tooltip', async (orig) => ({
  ...(await orig<object>()),
  Portal: Pass,
  Content: spy('tooltip'),
  Arrow: () => null,
}))

import {
  DropdownMenuContent,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import { PopoverContent } from '@/components/ui/popover'
import { HoverCardContent } from '@/components/ui/hover-card'
import { TooltipContent } from '@/components/ui/tooltip'

describe('popup edge defaults', () => {
  beforeEach(() => {
    for (const k of Object.keys(seen)) delete seen[k]
  })

  it('uses 12px for menus and popovers, 8px for tooltips', () => {
    expect(POPUP_COLLISION_PADDING).toBe(12)
    expect(TOOLTIP_COLLISION_PADDING).toBe(8)
  })

  it.each([
    ['dropdown', <DropdownMenuContent key="d" />, POPUP_COLLISION_PADDING],
    ['dropdown-sub', <DropdownMenuSubContent key="s" />, POPUP_COLLISION_PADDING],
    ['popover', <PopoverContent key="p" />, POPUP_COLLISION_PADDING],
    ['hover-card', <HoverCardContent key="h" />, POPUP_COLLISION_PADDING],
    ['tooltip', <TooltipContent key="t" />, TOOLTIP_COLLISION_PADDING],
  ])('%s passes the default collisionPadding', (name, el, pad) => {
    render(el)
    expect(seen[name]?.collisionPadding).toBe(pad)
    expect(String(seen[name]?.className)).toMatch(/max-w-\[calc\(100vw-/)
  })

  it('keeps a caller-supplied collisionPadding', () => {
    render(<PopoverContent collisionPadding={20} />)
    expect(seen.popover?.collisionPadding).toBe(20)
  })
})
