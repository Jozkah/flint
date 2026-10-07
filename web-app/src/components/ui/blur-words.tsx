import type { ReactNode } from 'react'

export type BlurWordsProps = {
  text: string
  /** Rendered after the last word, e.g. the waving hand. */
  trailing?: ReactNode
  className?: string
}

/**
 * Each word blurs in from above, 260ms after the one before, once on mount.
 * Screen readers get the whole sentence; the animated words are decoration.
 * With reduced motion the CSS leaves the words plain.
 */
export function BlurWords({ text, trailing, className }: BlurWordsProps) {
  const words = text.split(' ').filter(Boolean)
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="contents">
        {words.map((word, i) => (
          <span
            key={`${i}-${word}`}
            className="bw-word"
            style={{ ['--bw-i' as string]: i }}
          >
            {word}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
      </span>
      {trailing}
    </span>
  )
}
