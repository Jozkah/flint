import { useState } from 'react'
import { BrandMark } from '@/containers/engine/BrandMark'
import { modelLogo } from '@/lib/brandLogos'
import { cn } from '@/lib/utils'

/**
 * The picture Hugging Face shows for a model's author, so a result looks the
 * same here as it does on the site. An author is either an organisation or a
 * user and the two have separate endpoints, so the organisation is tried first
 * and then the user; if neither has a picture the model family's brand mark or
 * a tinted initial stands in.
 *
 * The request is made by the page that is showing the result, which is only
 * ever Discover, so it is covered by the same explicit-use boundary as the
 * search itself. Nothing is sent but the author name, and no referrer.
 */

const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/

/** What is already known about an author, so a 404 is not asked for twice. */
const known = new Map<string, 'organizations' | 'users' | 'none'>()

const TINTS = [
  'from-sky-400 to-indigo-500',
  'from-emerald-400 to-teal-600',
  'from-rose-400 to-pink-600',
  'from-amber-300 to-orange-500',
  'from-violet-400 to-fuchsia-600',
  'from-lime-400 to-emerald-600',
]

function avatarUrl(kind: 'organizations' | 'users', author: string) {
  return `https://huggingface.co/api/${kind}/${encodeURIComponent(author)}/avatar?redirect=true`
}

export function HuggingFaceAvatar({
  author,
  modelId,
  size = 44,
  className,
}: {
  author: string
  modelId?: string
  size?: number
  className?: string
}) {
  const valid = AUTHOR.test(author)
  const [kind, setKind] = useState<'organizations' | 'users' | 'none'>(
    valid ? (known.get(author) ?? 'organizations') : 'none'
  )
  const [loaded, setLoaded] = useState(false)

  if (kind !== 'none') {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className={cn(
          'relative inline-grid shrink-0 place-items-center overflow-hidden rounded-[min(12px,28%)] bg-card shadow-[inset_0_0_0_0.8px_var(--border)]',
          className
        )}
      >
        <img
          key={kind}
          src={avatarUrl(kind, author)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => {
            known.set(author, kind)
            setLoaded(true)
          }}
          onError={() => {
            const next = kind === 'organizations' ? 'users' : 'none'
            known.set(author, next)
            setLoaded(false)
            setKind(next)
          }}
          className={cn(
            'size-full object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      </span>
    )
  }

  const logo = modelId ? modelLogo(modelId) : undefined
  if (logo) {
    return (
      <BrandMark
        logo={logo}
        name={author}
        size={size}
        className={className}
      />
    )
  }
  let hash = 0
  for (const char of author) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      className={cn(
        'grid shrink-0 place-items-center rounded-[min(12px,28%)] bg-gradient-to-br font-semibold text-white shadow-lift',
        TINTS[hash % TINTS.length],
        className
      )}
    >
      {author.charAt(0).toUpperCase()}
    </span>
  )
}
