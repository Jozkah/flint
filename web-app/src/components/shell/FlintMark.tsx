import { cn } from '@/lib/utils'

/** The Flint mark: the struck flint rock from the app icon. */
export function FlintMark({ className }: { className?: string }) {
  return (
    <img
      src="/images/flint-mark.png"
      alt=""
      aria-hidden
      draggable={false}
      className={cn('shrink-0 object-contain select-none', className)}
    />
  )
}
