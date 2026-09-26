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
    ? 'text-fg-2'
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
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  )
}

/**
 * Which of the honest phrasings this total needs.
 *
 * Nothing measured at all is its own case: "at least 0 tokens" is technically
 * true and reads as "this session sends nothing", when the truth is that the
 * prompt and tool set are only assembled when a run starts.
 */
export function contextKey(total: {
  complete: boolean
  estimated: boolean
  tokens: number
}): string {
  if (!total.complete && total.tokens <= 0) {
    return 'common:readiness.tokensPending'
  }
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
  settingsMcpServers = 0,
}: {
  manifest: ReadinessManifest
  /**
   * MCP servers switched on in Settings. Cowork does not offer them, and
   * someone who enabled one would otherwise expect it here.
   */
  settingsMcpServers?: number
}) {
  const { t } = useTranslation()
  const total = accountedTotal(manifest.context)

  return (
    <section
      aria-label={t('common:readiness.title')}
      className="flex flex-col gap-2 rounded-[10px] border-[0.8px] border-border bg-card p-3 text-[12.5px]"
    >
      <h3 className="text-[11px] font-medium tracking-[0.025em] text-subtle-foreground uppercase">
        {t('common:readiness.title')}
      </h3>
      {/* One label column and one value column, as the design's key-value
          table: the labels line up down one edge. */}
      <dl className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 max-sm:grid-cols-[minmax(0,110px)_minmax(0,1fr)]">
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
        {manifest.worktree ? (
          <>
            {/* Which checkout, not merely that there is one: this is the row
                someone reads before letting a run change anything, and "an
                isolated worktree" is the same sentence for all of them. */}
            <Row label={t('common:readiness.worktree.path')}>
              <span title={manifest.worktree.path}>
                {manifest.worktree.path}
              </span>
            </Row>
            <Row label={t('common:readiness.worktree.branch')}>
              {manifest.worktree.branch} (
              {t('common:readiness.worktree.from', {
                sha: manifest.worktree.baseSha.slice(0, 8),
              })}
              )
            </Row>
            {manifest.worktree.uncommittedAtCreation.length > 0 ? (
              // Said before the work, not discovered after it: the run cannot
              // see these, so anything it concludes about them is wrong.
              <Row label={t('common:readiness.worktree.unseen.label')}>
                <span className="text-destructive">
                  {t('common:readiness.worktree.unseen.value', {
                    count: manifest.worktree.uncommittedAtCreation.length,
                  })}
                </span>
              </Row>
            ) : null}
          </>
        ) : null}
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
                      ? 'text-fg-2'
                      : 'text-muted-foreground'
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
            : t('common:readiness.builtins', {
                count: manifest.tools.builtins,
              })}
          {manifest.tools.mcpServers.length > 0
            ? ` · ${manifest.tools.mcpServers.join(', ')}`
            : ` · ${t('common:readiness.noMcp')}`}
          {manifest.tools.mcpServers.length === 0 && settingsMcpServers > 0 ? (
            <span
              className="block text-muted-foreground"
              data-testid="readiness-mcp-not-offered"
            >
              {t('common:readiness.mcpNotOffered')}
            </span>
          ) : null}
        </Row>
        {manifest.folder && manifest.tooling ? (
          // AH-068 / AH-069 / AH-070. What the model will be told about how
          // this project builds and tests, shown with the same evidence.
          <div className="contents" data-testid="readiness-tooling">
            <dt className="text-muted-foreground">
              {t('common:readiness.tooling.label')}
            </dt>
            <dd className="min-w-0">
              {manifest.tooling.state === 'loading' ? (
                t('common:readiness.tooling.loading')
              ) : manifest.tooling.state === 'failed' ? (
                <span className="text-muted-foreground">
                  {t('common:readiness.tooling.failed', {
                    kind: manifest.tooling.error.kind,
                  })}
                </span>
              ) : manifest.tooling.facts.length === 0 ? (
                t('common:readiness.tooling.none')
              ) : (
                <span className="flex flex-wrap gap-x-2">
                  {manifest.tooling.facts.map((fact, i) => (
                    <span
                      key={`${fact.kind}-${fact.value}-${fact.source}-${i}`}
                      data-testid="readiness-tooling-fact"
                      data-kind={fact.kind}
                      data-confidence={fact.confidence}
                      title={t('common:readiness.tooling.fact', {
                        value: fact.value,
                        confidence: fact.confidence,
                        source: fact.source,
                        reason: fact.reason,
                      })}
                      className={
                        fact.confidence === 'high'
                          ? 'text-fg-2'
                          : 'text-muted-foreground'
                      }
                    >
                      {fact.value}
                      {fact.command ? (
                        <code className="ml-1 font-mono">{fact.command}</code>
                      ) : null}
                    </span>
                  ))}
                </span>
              )}
              {manifest.tooling.state === 'ready' &&
              manifest.tooling.conflicts.length > 0 ? (
                <span className="block text-destructive">
                  {manifest.tooling.conflicts.join(' · ')}
                </span>
              ) : null}
              {manifest.tooling.state === 'ready' && manifest.tooling.truncated ? (
                <span className="block text-muted-foreground">
                  {t('common:readiness.tooling.incomplete', {
                    reason: manifest.tooling.truncated,
                  })}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
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
