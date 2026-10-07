// Phone-style settings lists: grouped inset rows with the app's duotone icons.
import type { ReactNode } from 'react'
import type { IconName } from '@/components/ui/icon'
import { Icon } from '@/components/ui/icon'
import { I } from './icons'
import { Sw, TypeSafeMark } from './bits'
import { t } from '../i18n'

export type IRowProps = {
  icon?: IconName | 'jev' | 'claude' | null
  label: ReactNode
  sub?: ReactNode
  val?: ReactNode
  /** A switch instead of a chevron. */
  sw?: boolean
  /** Marked experimental (the flask), as on the desktop. */
  exp?: boolean
  onClick?: () => void
  testId?: string
}

export function IRow({ icon, label, sub, val, sw, exp, onClick, testId }: IRowProps) {
  const tile =
    icon === 'jev' ? (
      <TypeSafeMark size={18} />
    ) : icon === 'claude' ? (
      <img src={`${import.meta.env.BASE_URL}images/logos/claude-color.svg`} style={{ width: 18, height: 18 }} alt="" />
    ) : icon ? (
      <Icon name={icon} size={18} />
    ) : null
  return (
    <button
      type="button"
      className={`irow${sw ? ' on' : ''}${icon ? '' : ' noic'}`}
      onClick={onClick}
      data-testid={testId}
      role={sw !== undefined ? 'switch' : undefined}
      aria-checked={sw}
    >
      {tile && <span className="tile">{tile}</span>}
      <span className="lab">
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {label}
          {exp && (
            <span title={t('common.experimental')} style={{ color: 'var(--subtle-foreground)', display: 'flex' }}>
              <I n="flask" size={13} />
            </span>
          )}
        </span>
        {sub && <small>{sub}</small>}
      </span>
      {val !== undefined && val !== null && <span className="val">{val}</span>}
      {sw !== undefined ? <Sw on={sw} /> : <I n="chevr" />}
    </button>
  )
}

export function Grp({ cap, foot, children }: { cap?: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="igrp">
      {cap && <div className="cap">{cap}</div>}
      <div className="ilist">{children}</div>
      {foot && <div className="foot2">{foot}</div>}
    </div>
  )
}
