import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getInstallRecommendations } from '@/lib/backendDependencies'

/**
 * Turns missing library names into install advice. Shared by the standalone
 * dialog and the first-run wizard, which reports the same failure inline rather
 * than stacking a modal on top of itself.
 */
export function DependencyAdvice({
  backend,
  missingLibraries,
}: {
  backend: string
  missingLibraries: string[]
}) {
  const { t } = useTranslation()
  const [showRawLibs, setShowRawLibs] = useState(false)
  const { recommendations, uncovered } = getInstallRecommendations(
    missingLibraries,
    backend
  )

  return (
    <div className="min-w-0 space-y-3" data-testid="dependency-advice">
      {recommendations.length > 0 ? (
        <>
          <p className="text-sm text-ink-2">
            {t('common:missingDependenciesDialog.installLabel')}
          </p>
          <ul className="space-y-2">
            {recommendations.map((rec) => (
              <li
                key={rec.label}
                className="space-y-1 rounded-md border border-border bg-sunken p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {rec.label}
                  </span>
                  {rec.url && (
                    <a
                      href={rec.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium text-brand-text hover:underline pointer-coarse:min-h-11"
                    >
                      {t('common:missingDependenciesDialog.download')}
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {rec.description}
                </p>
              </li>
            ))}
          </ul>

          {uncovered.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {t('common:missingDependenciesDialog.additionalLibraries')}
              </p>
              <ul className="space-y-1">
                {uncovered.map((lib) => (
                  <li
                    key={lib}
                    className="break-all rounded-sm border border-border bg-sunken px-2 py-1 font-mono text-xs text-ink-2"
                  >
                    {lib}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        // No known group -- fall back to the raw list.
        <div className="space-y-1">
          <p className="text-sm text-ink-2">
            {t('common:missingDependenciesDialog.missingLibraries')}
          </p>
          <ul className="max-h-[180px] space-y-1 overflow-y-auto">
            {missingLibraries.map((lib) => (
              <li
                key={lib}
                className="break-all rounded-sm border border-border bg-sunken px-2 py-1 font-mono text-sm text-foreground"
              >
                {lib}
              </li>
            ))}
          </ul>
        </div>
      )}

      {recommendations.length > 0 && missingLibraries.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showRawLibs}
            onClick={() => setShowRawLibs((v) => !v)}
            className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11"
          >
            {showRawLibs ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            {t('common:missingDependenciesDialog.showRawLibraries', {
              count: missingLibraries.length,
            })}
          </button>
          {showRawLibs && (
            <ul className="mt-2 max-h-[120px] space-y-1 overflow-y-auto">
              {missingLibraries.map((lib) => (
                <li
                  key={lib}
                  className="break-all rounded-sm bg-sunken px-2 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  {lib}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
