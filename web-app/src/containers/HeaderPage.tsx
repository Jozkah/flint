import { ReactNode, memo } from 'react'
import { createPortal } from 'react-dom'
import { useHeaderSlot } from '@/components/shell/HeaderSlot'

type HeaderPageProps = {
  children?: ReactNode
}

/**
 * A page's context controls (its title detail and primary actions). Inside
 * the app shell they are placed in the top header, beside the breadcrumb, so
 * every page shares one 52px header; outside it (tests, standalone windows)
 * they render in place as a plain bar.
 */
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  const headerSlot = useHeaderSlot()
  if (children === undefined || children === null) return null

  const content = (
    <div
      data-testid="page-header"
      className="flex h-full w-full min-w-0 items-center gap-1 motion-safe:animate-fade-in"
    >
      {children}
    </div>
  )

  if (headerSlot) {
    return headerSlot.slot ? createPortal(content, headerSlot.slot) : null
  }
  return (
    <div className="flex h-[52px] shrink-0 items-center px-3">{content}</div>
  )
})

export default HeaderPage
