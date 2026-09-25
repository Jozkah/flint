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
 * The first thing a new session shows: an invitation centred in the
 * conversation frame, with a few starting points laid out as cards so each one
 * reads as something to pick up rather than a line of help text.
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
    <div className="absolute inset-0 flex overflow-y-auto px-[18px]">
      <div className="m-auto flex w-full max-w-[520px] flex-col items-center gap-2.5 py-10 text-center motion-safe:animate-rise-in">
        <Handshake className="size-9 text-muted-foreground" aria-hidden />
        <h1 className="text-[22px] font-medium tracking-[-0.01em] text-foreground">
          {t('common:coworkEmpty.title')}
        </h1>
        <p className="mb-2.5 text-[13.5px] leading-normal text-muted-foreground">
          {name
            ? t('common:coworkEmpty.subtitleFolder', { folder: name })
            : t('common:coworkEmpty.subtitleSandbox')}
        </p>

        <p className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
          {t('common:coworkEmpty.try')}
        </p>
        <div className="flex w-full flex-col gap-2">
          {EXAMPLE_KEYS.map((key) => {
            const text = t(`common:coworkEmpty.${scope}.${key}`, {
              folder: name,
            })
            return (
              <button
                key={key}
                type="button"
                onClick={() => onPick(text)}
                className="w-full rounded-[10px] border-[0.8px] border-border bg-card px-3.5 py-2.5 text-left text-[13px] text-secondary-foreground outline-none transition-[box-shadow,color,transform] duration-150 ease-expo hover:-translate-y-px hover:text-foreground hover:shadow-lift focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:min-h-11"
              >
                {text}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
