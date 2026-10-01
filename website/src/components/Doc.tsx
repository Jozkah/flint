import type { ReactNode } from 'react'
import { ExternalLink } from './ui'
import { LINKS } from '../lib/site'

export type Sec = { id: string; title: string; body: ReactNode }

type Props = {
  eyebrow: string
  title: string
  lede?: ReactNode
  /** Shown as "Last updated". Legal pages only. */
  updated?: string
  /** File name under website/src/pages, linked so readers can see the page's history. */
  source?: string
  sections: Sec[]
  toc?: boolean
}

export function DocPage({ eyebrow, title, lede, updated, source, sections, toc = true }: Props) {
  return (
    <article className="doc">
      <header className="doc-head wrap-wide">
        <p className="eyebrow">
          <span className="dot" />
          {eyebrow}
        </p>
        <h1 className="doc-title">{title}</h1>
        {lede && <p className="lede">{lede}</p>}
        {(updated || source) && (
          <p className="doc-meta">
            {updated && <span>Last updated {updated}</span>}
            {source && (
              <ExternalLink href={`${LINKS.src}/${source}`} className="link">
                View this page’s source and history
              </ExternalLink>
            )}
          </p>
        )}
      </header>
      <div className={`wrap-wide doc-grid ${toc ? '' : 'no-toc'}`}>
        {toc && (
          <nav className="toc" aria-label="On this page">
            <p className="eyebrow">On this page</p>
            <ol>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="prose">
          {sections.map((s) => (
            <section key={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={s.id}>
                <span id={`${s.id}-h`}>{s.title}</span>
              </h2>
              {s.body}
            </section>
          ))}
        </div>
      </div>
    </article>
  )
}

export function Callout({ title, children, tone }: { title?: string; children: ReactNode; tone?: 'warn' }) {
  return (
    <aside className={`callout ${tone ?? ''}`}>
      {title && <b>{title}</b>}
      <div>{children}</div>
    </aside>
  )
}

export const Ext = ({ href, children }: { href: string; children: ReactNode }) => <ExternalLink href={href}>{children}</ExternalLink>

export function Table({ head, rows, label }: { head: string[]; rows: ReactNode[][]; label: string }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
