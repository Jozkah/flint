import * as React from 'react'
import { useTextOverflow } from '@/hooks/useTextOverflow'

type FadeTextProps<T extends React.ElementType> = {
  as?: T
  className?: string
} & Omit<React.ComponentPropsWithoutRef<T>, 'as' | 'className'>

/**
 * A single line of text that fades out at its right edge, only when it is
 * too long for its box. Short text is drawn without the fade.
 *
 * The class is joined by hand, not through cn(): tailwind-merge takes
 * text-fade for a text colour and drops it beside one.
 */
export function FadeText<T extends React.ElementType = 'span'>({
  as,
  className,
  ...props
}: FadeTextProps<T>) {
  const ref = React.useRef<HTMLElement>(null)
  useTextOverflow(ref)
  const Comp = (as ?? 'span') as React.ElementType
  return (
    <Comp
      ref={ref}
      className={className ? `text-fade ${className}` : 'text-fade'}
      {...props}
    />
  )
}
