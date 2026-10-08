// Small pieces the phone's screens share, in the design's classes
// (mobile.css).
import type { ReactNode } from 'react'
import { ModelAvatar } from '@/containers/ModelAvatar'
import { Icon, type IconName } from '@/components/ui/icon'
import { TypeSafeMark } from '@/components/ui/TypeSafeMark'
import { I } from './icons'

import { MARK } from './format'
import { t } from '../i18n'

export function FlintMark({ size, className }: { size?: number; className?: string }) {
  return (
    <img
      src={MARK}
      alt=""
      className={className}
      style={{ imageRendering: 'pixelated', ...(size ? { width: size, height: size } : {}) }}
    />
  )
}

/** A model's mark: the family or provider logo, else initials on a tone. */
export function Avatar({
  id,
  name,
  provider,
  size = 18,
  square,
}: {
  id: string
  name?: string
  provider?: string
  size?: number
  square?: boolean
}) {
  return (
    <ModelAvatar
      modelId={id}
      name={name}
      provider={provider}
      size={size}
      className={square ? 'rounded-[8px]' : undefined}
    />
  )
}

/** The design's duotone icon (components/ui/icon). */
export function D({ n, size = 16, style }: { n: IconName; size?: number; style?: React.CSSProperties }) {
  const icon = <Icon name={n} size={size} />
  return style ? (
    <span style={{ display: 'inline-flex', flex: 'none', ...style }} aria-hidden>
      {icon}
    </span>
  ) : (
    icon
  )
}

export { TypeSafeMark }

export function Grab() {
  return <div className="grab" aria-hidden />
}

export function Sw({ on }: { on: boolean }) {
  return <span className={`sw${on ? ' on' : ''}`} aria-hidden />
}

/** A bottom-sheet option row. */
export function Opt({
  title,
  sub,
  lead,
  selected,
  danger,
  trail,
  onClick,
  testId,
}: {
  title: ReactNode
  sub?: ReactNode
  lead?: ReactNode
  selected?: boolean
  danger?: boolean
  trail?: ReactNode
  onClick?: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      className={`opt${danger ? ' dang' : ''}`}
      aria-pressed={selected === undefined ? undefined : selected}
      onClick={onClick}
      data-testid={testId}
    >
      {lead}
      <span className="tx">
        <b>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      {trail ?? (selected !== undefined && <I n="check" size={15} className="ck" />)}
    </button>
  )
}

export function Kv({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={`kv${className ? ` ${className}` : ''}`}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  )
}

export function Pills<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: readonly { id: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`pills${className ? ` ${className}` : ''}`} role="group">
      {items.map((it) => (
        <button key={it.id} type="button" aria-pressed={it.id === value} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty" role="status">
      {icon && <div style={{ display: 'grid', placeItems: 'center', marginBottom: 8 }}>{icon}</div>}
      {children}
    </div>
  )
}

export function Loading({ label = t('common.loading') }: { label?: string }) {
  return (
    <div className="empty" role="status" aria-live="polite">
      <I n="loader" spin size={18} />
      <div style={{ marginTop: 6 }}>{label}</div>
    </div>
  )
}
