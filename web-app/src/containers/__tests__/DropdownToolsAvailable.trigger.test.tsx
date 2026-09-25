/**
 * The composer's tools control was a div dropdown trigger (aria-haspopup)
 * nested inside a button. The dropdown trigger must now be the button itself.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: (sel: (s: { tools: unknown[] }) => unknown) => sel({ tools: [] }),
}))

import DropdownToolsAvailable from '@/containers/DropdownToolsAvailable'

describe('composer tools trigger', () => {
  it('is a single button carrying the popup, with nothing interactive inside', () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <DropdownToolsAvailable>
            {() => (
              <TooltipTrigger asChild>
                <Button aria-label="tools">
                  <Wrench />
                </Button>
              </TooltipTrigger>
            )}
          </DropdownToolsAvailable>
          <TooltipContent>tools</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    const trigger = buttons[0]
    expect(trigger.getAttribute('aria-label')).toBe('tools')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.querySelector('[aria-haspopup], button, [role="button"]')).toBeNull()
  })
})
