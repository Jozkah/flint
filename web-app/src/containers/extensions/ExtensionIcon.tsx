/* eslint-disable react-refresh/only-export-components */
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Gradient icon tiles for extensions: the built-in engine pieces and known
 * plugins get their own glyph and colours; anything else gets a stable
 * colour pair derived from its name and a puzzle glyph, so every card still
 * reads as a distinct object.
 */
type IconDef = { from: string; to: string; glyph: ReactNode }

const Glyph = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="#fff"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-[52%]"
    aria-hidden
  >
    {children}
  </svg>
)

const FLINT_LOGO = (
  <img
    src="/images/flint-logo.png"
    alt=""
    className="size-[78%] object-contain"
    draggable={false}
  />
)

const ICONS: Record<string, IconDef> = {
  'flint-core': { from: '#3b3f46', to: '#16181c', glyph: FLINT_LOGO },
  'release-kit': {
    from: '#f97316',
    to: '#db2777',
    glyph: (
      <Glyph>
        <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1z" />
        <path d="M12 15l-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z" />
        <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
      </Glyph>
    ),
  },
  'design-kit': {
    from: '#a855f7',
    to: '#6366f1',
    glyph: (
      <Glyph>
        <circle cx="13.5" cy="6.5" r="1.3" fill="#fff" />
        <circle cx="17.5" cy="10.5" r="1.3" fill="#fff" />
        <circle cx="8.5" cy="7.5" r="1.3" fill="#fff" />
        <circle cx="6.5" cy="12.5" r="1.3" fill="#fff" />
        <path d="M12 2a10 10 0 0 0 0 20c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9z" />
      </Glyph>
    ),
  },
  're-toolkit': {
    from: '#10b981',
    to: '#0e7490',
    glyph: (
      <Glyph>
        <path d="m8 2 1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1" />
        <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" />
      </Glyph>
    ),
  },
  'obsidian-bridge': {
    from: '#7c3aed',
    to: '#312e81',
    glyph: (
      <Glyph>
        <path d="M12 2 5 7l1.5 10L12 22l5.5-5L19 7z" />
        <path d="M12 2v20M5 7l7 4 7-4" />
      </Glyph>
    ),
  },
  'sql-helper': {
    from: '#0ea5e9',
    to: '#1d4ed8',
    glyph: (
      <Glyph>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </Glyph>
    ),
  },
  'figma-context': {
    from: '#f43f5e',
    to: '#f59e0b',
    glyph: (
      <Glyph>
        <path d="M5 5.5A3.5 3.5 0 0 1 8.5 2H12v7H8.5A3.5 3.5 0 0 1 5 5.5zM12 2h3.5a3.5 3.5 0 1 1 0 7H12zM12 12.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 1 1-7 0zM5 19.5A3.5 3.5 0 0 1 8.5 16H12v3.5a3.5 3.5 0 1 1-7 0zM5 12.5A3.5 3.5 0 0 1 8.5 9H12v7H8.5A3.5 3.5 0 0 1 5 12.5z" />
      </Glyph>
    ),
  },
  'k8s-ops': {
    from: '#3b82f6',
    to: '#1e3a8a',
    glyph: (
      <Glyph>
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v6M12 15v6M4.2 7.5l5.2 3M14.6 13.5l5.2 3M4.2 16.5l5.2-3M14.6 10.5l5.2-3" />
      </Glyph>
    ),
  },
  'Jan Assistant': {
    from: '#f59e0b',
    to: '#ea580c',
    glyph: (
      <Glyph>
        <path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
      </Glyph>
    ),
  },
  Conversational: {
    from: '#06b6d4',
    to: '#2563eb',
    glyph: (
      <Glyph>
        <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
        <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
      </Glyph>
    ),
  },
  'llama.cpp Inference Engine': {
    from: '#64748b',
    to: '#1e293b',
    glyph: (
      <Glyph>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <rect x="9" y="9" width="6" height="6" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
      </Glyph>
    ),
  },
  'MLX Inference Engine': {
    from: '#9ca3af',
    to: '#374151',
    glyph: (
      <Glyph>
        <path d="M12 20.9c-1.4 0-2.1-.9-3.5-.9s-2.2.9-3.5.9C2.6 20.9 1 16 1 12.5 1 9.3 3 7.6 5 7.6c1.4 0 2.4.9 3.5.9s2.4-.9 3.9-.9c1.1 0 2.8.5 3.8 2-2.4 1.4-2 4.9.4 6-.7 2-2.2 5.3-4.6 5.3zM12 7c-.2-2.3 1.7-4.4 4-4.5.2 2.4-2.1 4.6-4 4.5z" />
      </Glyph>
    ),
  },
  'RAG Tools': {
    from: '#22c55e',
    to: '#15803d',
    glyph: (
      <Glyph>
        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
        <circle cx="12" cy="10" r="2.5" />
        <path d="m14 12 2 2" />
      </Glyph>
    ),
  },
  'Vector DB': {
    from: '#ec4899',
    to: '#9333ea',
    glyph: (
      <Glyph>
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <circle cx="12" cy="10" r="1.5" />
        <path d="M7.5 7.3 10.8 9.2M16.5 7.3 13.2 9.2M12 11.5V16" />
      </Glyph>
    ),
  },
}

/** Colour pairs for extensions without their own icon. */
const PAIRS: Array<[string, string]> = [
  ['#10b981', '#0e7490'],
  ['#0ea5e9', '#1d4ed8'],
  ['#7c3aed', '#312e81'],
  ['#f43f5e', '#f59e0b'],
  ['#3b82f6', '#1e3a8a'],
  ['#f97316', '#db2777'],
  ['#a855f7', '#6366f1'],
]

const PUZZLE = (
  <Glyph>
    <path d="M15.4 8.6h2.1a2 2 0 1 0 0-4h-2.1V3.3A1.3 1.3 0 0 0 14.1 2H10a1.3 1.3 0 0 0-1.3 1.3v1.3H6.6a2 2 0 1 0 0 4h2.1V11H6.6a2 2 0 1 0 0 4h2.1v5.7A1.3 1.3 0 0 0 10 22h4.1a1.3 1.3 0 0 0 1.3-1.3V15h2.1a2 2 0 1 0 0-4h-2.1z" />
  </Glyph>
)

/** The colours and glyph for an extension, by its name or id. */
export function extensionIcon(name: string): IconDef {
  const known = ICONS[name]
  if (known) return known
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const [from, to] = PAIRS[Math.abs(h) % PAIRS.length]
  return { from, to, glyph: PUZZLE }
}

/** The rounded gradient tile holding an extension's glyph. */
export function ExtensionIcon({
  name,
  size = 40,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  const { from, to, glyph } = extensionIcon(name)
  return (
    <span
      aria-hidden
      data-slot="extension-icon"
      style={
        {
          width: size,
          height: size,
          '--g1': from,
          '--g2': to,
        } as CSSProperties
      }
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-[min(12px,30%)] bg-[linear-gradient(135deg,var(--g1),var(--g2))]',
        className
      )}
    >
      {glyph}
    </span>
  )
}
