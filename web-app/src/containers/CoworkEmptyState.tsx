import { Handshake } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { basenameOf } from '@/lib/coworkPreview'

type Props = {
  /** Attached project folder, or null when nothing is attached. */
  folder: string | null
  /** Loads an example into the composer. Never sends it: an example is a
   * starting point the user is expected to edit. */
  onPick: (text: string) => void
}

const EXAMPLE_KEYS = ['first', 'second', 'third'] as const

/**
 * The first thing a new session shows.
 *
 * Anchored to the composer rather than centred in the viewport: the block sits
 * directly above the input, sharing its width and left edge, so the eye travels
 * from the invitation into the box. Centring it left a heading marooned in the
 * middle of an empty pane, and made the jump to the first message jarring.
 *
 * The examples name the attached folder when there is one. That is the whole
 * point of them -- a fixed list of suggestions is wallpaper, but "Find every
 * TODO in jan-app" is a task you might actually run next.
 */
export function CoworkEmptyState({ folder, onPick }: Props) {
  const { t } = useTranslation()
  const name = folder ? basenameOf(folder) : null
  const scope = name ? 'folder' : 'sandbox'

  return (
    <div className="absolute inset-0 flex flex-col justify-end px-3 pb-2">
      <div className="mx-auto w-full md:w-4/5 xl:w-4/6">
        <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500">
          <Handshake size={20} className="text-brand-text" aria-hidden />
          <h1 className="mt-3 font-display text-3xl font-normal tracking-tight text-foreground">
            {t('common:coworkEmpty.title')}
          </h1>
          <p className="mt-1.5 max-w-lg text-sm text-muted-foreground">
            {name
              ? t('common:coworkEmpty.subtitleFolder', { folder: name })
              : t('common:coworkEmpty.subtitleSandbox')}
          </p>

          <p className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('common:coworkEmpty.try')}
          </p>
          <div className="mt-1 flex flex-col items-start gap-0.5">
            {EXAMPLE_KEYS.map((key) => {
              const text = t(`common:coworkEmpty.${scope}.${key}`, {
                folder: name,
              })
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onPick(text)}
                  className="max-w-full rounded-md border border-transparent px-2 py-1.5 text-left text-sm text-ink-2 outline-none transition-colors hover:border-border hover:bg-card hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11"
                >
                  {text}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
