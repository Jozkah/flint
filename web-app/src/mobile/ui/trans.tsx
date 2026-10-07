import { Fragment, type ReactNode } from 'react'
import { t, type Vars } from '../i18n'

/** A translated sentence with React nodes in some places: `{{name}}` in the
 * text becomes `parts.name`, so a translation may reorder them (the bold
 * number in "Turn 3 of 8"). Plain values go in `vars` as for `t`. */
export function Tx({ k, vars, parts }: { k: string; vars?: Vars; parts: Record<string, ReactNode> }) {
  const names = Object.keys(parts)
  const pieces = t(k, vars).split(new RegExp(`\\{\\{(${names.join('|')})\\}\\}`))
  return (
    <>
      {pieces.map((piece, i) => (i % 2 === 1 ? <Fragment key={i}>{parts[piece]}</Fragment> : piece))}
    </>
  )
}
