import { useTranslation } from '@/i18n/react-i18next-compat'
import { modeLabelKey } from '@/lib/coworkMode'
import {
  accountedTotal,
  CONTEXT_CATEGORIES,
  type InstructionFile,
  type ContextAccounting,
  type ReadinessManifest,
  type ResolvedSkill,
} from '@/lib/coworkReadiness'

/**
 * What this run is about to be given, before it is given it.
 *
 * Render-only on purpose. It resolves nothing and reads nothing: it is handed
 * the same manifest the prompt is built from, so the two cannot drift into
 * describing different runs. Everything shown here is therefore a fact about
 * the run, not a second opinion about it.
 *
 * A row, not a modal. Someone about to type into the composer needs to be able
 * to check the repository and the mode without dismissing anything.
 */

const instructionSummaryKey = (file: InstructionFile): string =>
  `common:readiness.instruction.${file.state.kind}`

const skillToneClass = (skill: ResolvedSkill): string =>
  skill.state === 'active'
    ? 'text-main-view-fg/80'
    : // Everything else means the user asked for something they did not get.
      'text-destructive'

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-main-view-fg/50">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}

/** Which of the four honest phrasings this total needs. */
function contextKey(total: {
  complete: boolean
  estimated: boolean
}): string {
  if (total.estimated) {
    return total.complete
      ? 'common:readiness.tokensEstimated'
      : 'common:readiness.tokensEstimatedPartial'
  }
  return total.complete
    ? 'common:readiness.tokens'
    : 'common:readiness.tokensPartial'
}

/**
 * The method behind the derived numbers, for the reader to judge.
 *
 * Categories are measured the same way, so the first method found stands for
 * the total; naming one is what stops "~12,000 tokens" from reading as a count.
 */
function estimateMethod(accounting: ContextAccounting): string {
  for (const category of CONTEXT_CATEGORIES) {
    const value = accounting.categories[category]
    if (value.known === 'estimated') return value.method
  }
  return ''
}

export function CoworkReadinessCard({
  manifest,
}: {
  manifest: ReadinessManifest
}) {
  const { t } = useTranslation()
  const total = accountedTotal(manifest.context)

  return (
    <section
      aria-label={t('common:readiness.title')}
      className="rounded-md border border-border bg-main-view-fg/2 px-3 py-2 text-xs"
    >
      <dl className="grid gap-1 sm:grid-cols-2">
        <Row label={t('common:readiness.repository')}>
          {/* The canonical path, not what was typed: this is the row someone
              checks when they suspect the wrong repository is attached. */}
          <span title={manifest.folder ?? undefined}>
            {manifest.folder ?? t('common:readiness.noRepository')}
          </span>
        </Row>
        <Row label={t('common:readiness.branch')}>
          {manifest.branch ?? t('common:readiness.unknown')}
        </Row>
        <Row label={t('common:readiness.mode')}>
          {t(modeLabelKey(manifest.mode))}
        </Row>
        <Row label={t('common:readiness.writesGo')}>
          {t(`common:readiness.destination.${manifest.writeDestination}`)}
        </Row>
        {manifest.evidence ? (
          // Said before the run, not only in the summary after it: whether
          // anything this agent does will be attributable is part of deciding
          // whether to let it work here at all.
          <Row label={t('common:readiness.evidence.label')}>
            {t(`common:readiness.evidence.${manifest.evidence}`)}
          </Row>
        ) : null}
        <Row label={t('common:readiness.instructions')}>
          {manifest.instructions.length === 0 ? (
            t('common:readiness.noInstructions')
          ) : (
            <span className="flex flex-wrap gap-x-2">
              {manifest.instructions.map((file) => (
                <span
                  key={file.name}
                  className={
                    file.active
                      ? 'text-main-view-fg/80'
                      : 'text-main-view-fg/50'
                  }
                >
                  {file.name} · {t(instructionSummaryKey(file))}
                  {!file.active && file.state.kind === 'loaded'
                    ? ` (${t('common:readiness.detectedOnly')})`
                    : ''}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label={t('common:readiness.skills')}>
          {manifest.skills.length === 0 ? (
            t('common:readiness.noSkillsRequested')
          ) : (
            <span className="flex flex-wrap gap-x-2">
              {manifest.skills.map((skill) => (
                <span key={skill.requested} className={skillToneClass(skill)}>
                  {skill.matched ?? skill.requested} ·{' '}
                  {t(`common:readiness.skill.${skill.state}`)}
                </span>
              ))}
            </span>
          )}
        </Row>
        <Row label={t('common:readiness.model')}>
          {manifest.model.id ?? t('common:readiness.noModel')}
          {' · '}
          {manifest.model.supportsTools === null
            ? t('common:readiness.toolsUnknown')
            : manifest.model.supportsTools
              ? t('common:readiness.toolsSupported')
              : t('common:readiness.toolsUnsupported')}
        </Row>
        <Row label={t('common:readiness.tools')}>
          {manifest.tools.builtins == null
            ? t('common:readiness.builtinsUnknown')
            : t('common:readiness.builtins', { count: manifest.tools.builtins })}
          {manifest.tools.mcpServers.length > 0
            ? ` · ${manifest.tools.mcpServers.join(', ')}`
            : ` · ${t('common:readiness.noMcp')}`}
        </Row>
        <Row label={t('common:readiness.context')}>
          {/* Two separate admissions, and the wording keeps them separate.
              "At least" covers a category that could not be measured at all;
              the tilde and the named method cover a number that was derived
              rather than counted. A total that silently omitted either would
              read as an exact and complete one. */}
          {t(contextKey(total), {
            count: total.tokens,
            method: estimateMethod(manifest.context),
          })}
        </Row>
      </dl>
    </section>
  )
}
