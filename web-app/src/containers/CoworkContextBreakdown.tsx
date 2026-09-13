import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  CONTEXT_CATEGORIES,
  accountedTotal,
  type ContextAccounting,
  type ContextCategory,
  type Measured,
} from '@/lib/coworkReadiness'
import { formatContextUsage } from '@/lib/modelCapabilities'

/**
 * Where the context went, category by category.
 *
 * The total on the readiness card answers "how much"; this answers "of what",
 * which is the half that makes the number act on. A run whose 14,000 tokens are
 * mostly tool definitions and a run whose 14,000 tokens are mostly conversation
 * need different things done about them, and the total cannot tell them apart.
 *
 * Render-only, and fed the same accounting the card totals, so the parts and
 * the sum cannot disagree.
 *
 * The rows nobody usually thinks to look for are the point: a category that
 * contributed *nothing* is shown, not hidden. "Repository map — nothing sent"
 * is the single most useful line here, because it is the answer to the
 * complaint that started this work, and an empty row would have been dropped by
 * any layout that only lists what it has.
 */

const categoryLabelKey = (category: ContextCategory): string =>
  `common:readiness.contextCategory.${category}`

/** One category's figure, in the wording its state has earned. */
function value(
  measured: Measured,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (measured.known === false) return t('common:readiness.categoryUnknown')
  if (measured.tokens === 0) return t('common:readiness.categoryNothing')
  if (measured.known === 'estimated') {
    return t('common:readiness.categoryEstimated', { count: measured.tokens })
  }
  return t('common:readiness.categoryCounted', { count: measured.tokens })
}

export function CoworkContextBreakdown({
  context,
}: {
  context: ContextAccounting
}) {
  const { t } = useTranslation()
  const total = accountedTotal(context)
  const budget = context.budget

  // Only meaningful when both halves are known. A "remaining" computed against
  // an unknown window would be an invented reassurance, and computed from an
  // incomplete total it would overstate what is left.
  const usage =
    budget.known !== false && total.complete
      ? { used: total.tokens, window: budget.tokens }
      : null

  // Collapsed by default. This is reference material for the moment someone
  // asks "what did the model actually get"; it sat open above the composer on
  // every single message, pushing the conversation up the screen.
  return (
    <details
      className="group rounded-md border border-border bg-sunken/60 px-3 py-2 text-xs"
      aria-label={t('common:readiness.contextBreakdown')}
    >
      <summary className="cursor-pointer list-none text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm">
        {t('common:readiness.contextBreakdown')}
      </summary>
      <div className="mt-1">
      <dl className="grid gap-1">
        {CONTEXT_CATEGORIES.map((category) => (
          <div key={category} className="flex items-baseline gap-2">
            <dt className="shrink-0 text-muted-foreground">
              {t(categoryLabelKey(category))}
            </dt>
            <dd className="min-w-0 truncate">
              {value(context.categories[category], t)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline gap-2">
          <dt className="shrink-0 text-muted-foreground">
            {t('common:readiness.budgetLabel')}
          </dt>
          <dd className="min-w-0 truncate">
            {usage == null
              ? t('common:readiness.budgetUnknown')
              : usage.used > usage.window
                ? t('common:readiness.budgetOver', {
                    over: usage.used - usage.window,
                  })
                : // "3,367 / 32,768 tokens": both numbers, grouped, so the
                  // headroom is read rather than worked out.
                  (formatContextUsage(usage.used, usage.window) ??
                  t('common:readiness.budgetUnknown'))}
          </dd>
        </div>
      </dl>
      </div>
    </details>
  )
}
