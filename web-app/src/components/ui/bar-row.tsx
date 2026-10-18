import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTextOverflow } from '@/hooks/useTextOverflow'
import { cn } from '@/lib/utils'

/** How an action is drawn: with its label, as its icon alone, or in "...". */
export type BarActionForm = 'label' | 'icon' | 'menu'

export type BarAction = {
  id: string
  label: string
  icon?: ReactNode
  /** Draw the icon only once the label is gone (default: beside it too). */
  iconOnlyCollapsed?: boolean
  onSelect: () => void
  disabled?: boolean
  /** Hover text for the labelled form; the icon form shows the label. */
  title?: string
  testId?: string
  variant?: ComponentProps<typeof Button>['variant']
  /** Lower ranks collapse first. */
  rank?: number
  /** The furthest this action collapses (default: into the menu). */
  floor?: BarActionForm
}

const ORDER: Record<BarActionForm, number> = { label: 0, icon: 1, menu: 2 }

/**
 * Every form the actions pass through as the row gets narrower, widest
 * first, lowest rank first within each phase: the actions that may leave the
 * row drop to icons, then move into the "..." menu; then the ones that stay
 * drop to icons. Each action stops at its `floor`.
 */
export function collapseSteps(
  actions: readonly BarAction[]
): Record<string, BarActionForm>[] {
  return collapsePlan(actions).steps
}

/**
 * The steps, and the one from which the text also gives up its floor: after
 * the actions that may leave the row have left, before the kept ones lose
 * their labels.
 */
export function collapsePlan(actions: readonly BarAction[]) {
  const byRank = [...actions].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
  const current: Record<string, BarActionForm> = {}
  for (const a of actions) current[a.id] = 'label'
  const steps = [{ ...current }]
  const allows = (a: BarAction, form: BarActionForm) =>
    ORDER[form] <= ORDER[a.floor ?? 'menu']
  const step = (a: BarAction, form: BarActionForm) => {
    current[a.id] = form
    steps.push({ ...current })
  }
  const secondary = byRank.filter((a) => allows(a, 'menu'))
  // Actions that may go into the menu give up their labels, then go there;
  // only then do the ones that stay out of it lose their labels.
  for (const a of secondary) if (a.icon) step(a, 'icon')
  for (const a of secondary) step(a, 'menu')
  const squeezeAt = steps.length
  for (const a of byRank)
    if (a.icon && !allows(a, 'menu') && allows(a, 'icon')) step(a, 'icon')
  return { steps, squeezeAt }
}

/** Whether the row's content is wider than its box. */
function overflows(el: HTMLElement) {
  // +1: sub-pixel rounding must not read as overflow.
  return el.scrollWidth > el.clientWidth + 1
}

/**
 * One bar over the composer, always one row. The text fades rather than
 * wrapping, and as the row narrows its actions give up their labels, then
 * move into a "..." menu, lowest rank first, until everything fits.
 */
export function BarRow({
  icon,
  lead,
  leadTitle,
  leadTestId,
  leadClassName,
  meta,
  actions,
  trailing,
  className,
  testId,
  ...rest
}: {
  icon?: ReactNode
  /** The bar's text, on one line that fades at its end as it shrinks. */
  lead: ReactNode
  leadTitle?: string
  leadTestId?: string
  leadClassName?: string
  /** Kept whole beside the text (counts, a status). */
  meta?: ReactNode
  actions: readonly BarAction[]
  /** After the actions and the menu (a dismiss button). */
  trailing?: ReactNode
  className?: string
  testId?: string
} & Omit<ComponentProps<'div'>, 'children'>) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const leadRef = useRef<HTMLSpanElement>(null)
  useTextOverflow(leadRef)
  const { steps, squeezeAt } = collapsePlan(actions)
  const [stage, setStage] = useState(0)
  // One stage more than there are forms: the text gives up its floor (at
  // `squeezeAt`), so nothing is ever clipped at the row's end.
  const last = steps.length
  const at = Math.min(stage, last)
  const squeezed = at >= squeezeAt
  const forms = steps[squeezed ? at - 1 : at]
  // What the actions say: a new label measures again from the widest form.
  const signature = actions
    .map((a) => `${a.id}:${a.label}:${a.disabled ? 1 : 0}`)
    .join('|')
  const measured = useRef(signature)
  const maxStage = useRef(0)
  maxStage.current = last

  // One step narrower per pass while the row still overflows; every pass
  // runs before paint.
  useLayoutEffect(() => {
    if (measured.current !== signature) {
      measured.current = signature
      setStage(0)
      return
    }
    const el = ref.current
    if (el && at < last && overflows(el)) setStage(at + 1)
  }, [signature, at, last])

  // Wider again: start over from the widest form.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      const next = el.clientWidth
      // Already at the widest form (a row shown from hidden, 0px wide, says
      // nothing changed): step on at once when it does not fit.
      if (next > width) setStage((s) => (s === 0 && overflows(el) ? 1 : 0))
      else if (overflows(el)) setStage((s) => Math.min(s + 1, maxStage.current))
      width = next
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const inMenu = actions.filter((a) => forms[a.id] === 'menu')

  return (
    <div
      ref={ref}
      data-testid={testId}
      data-bar-row=""
      data-bar-stage={at}
      className={cn(
        'flex h-9 min-w-0 flex-nowrap items-center gap-2 overflow-hidden rounded-[10px] pr-1 pl-3 text-sm pointer-coarse:h-12',
        className
      )}
      {...rest}
    >
      {icon}
      <span
        ref={leadRef}
        title={leadTitle}
        data-testid={leadTestId}
        // Outside cn: tailwind-merge reads `text-fade` as a text colour and
        // would drop it beside one.
        className={`text-fade ${cn(squeezed ? 'min-w-0' : 'min-w-[6em]', 'flex-1', leadClassName)}`}
      >
        {lead}
      </span>
      {meta}
      {actions.map((a) => {
        const form = forms[a.id]
        if (form === 'menu') return null
        if (form === 'icon')
          return (
            <Tooltip key={a.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant={a.variant ?? 'ghost'}
                  disabled={a.disabled}
                  aria-label={a.label}
                  data-testid={a.testId}
                  data-bar-action={a.id}
                  className="shrink-0 pointer-coarse:size-11"
                  onClick={a.onSelect}
                >
                  {a.icon}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{a.label}</TooltipContent>
            </Tooltip>
          )
        return (
          <Button
            key={a.id}
            type="button"
            size="sm"
            variant={a.variant ?? 'ghost'}
            disabled={a.disabled}
            title={a.title}
            data-testid={a.testId}
            data-bar-action={a.id}
            className="shrink-0 pointer-coarse:h-11"
            onClick={a.onSelect}
          >
            {a.iconOnlyCollapsed ? null : a.icon}
            {a.label}
          </Button>
        )
      })}
      {inMenu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('common:coworkBars.moreActions')}
              data-testid={testId ? `${testId}-more` : undefined}
              className="shrink-0 pointer-coarse:size-11"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {inMenu.map((a) => (
              <DropdownMenuItem
                key={a.id}
                disabled={a.disabled}
                data-testid={a.testId ? `${a.testId}-menu` : undefined}
                onSelect={a.onSelect}
              >
                {a.icon}
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {trailing}
    </div>
  )
}
