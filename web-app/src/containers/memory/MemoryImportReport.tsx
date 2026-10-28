import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MemoryImportReport as Report } from '@janhq/tauri-plugin-agent-tools-api'

/** What the last import did, record by record. */
export function MemoryImportReport({ report }: { report: Report }) {
  const { t } = useTranslation()
  return (
      <div
        className="rounded-md bg-muted p-3 text-xs text-fg-2"
        role="status"
        data-testid="memory-import-report"
        data-imported={report.imported.length}
        data-duplicates={report.duplicates.length}
        data-refused={report.refused.length}
      >
        <p>
          {t('settings:memoryPage.importReport.summary', {
            count: report.imported.length,
          })}{' '}
          <span className="font-mono">{report.exportId}</span>
          {report.duplicates.length > 0 &&
            ` · ${t('settings:memoryPage.importReport.duplicates', { count: report.duplicates.length })}`}
          {report.refused.length > 0 &&
            ` · ${t('settings:memoryPage.importReport.refused', { count: report.refused.length })}`}
        </p>
        {report.refused.length > 0 && (
          <ul className="mt-1 list-disc pl-4" data-testid="memory-import-refused">
            {report.refused.map((r) => (
              <li key={`${r.index}-${r.originalId}`}>
                #{r.index + 1} <span className="font-mono">{r.originalId}</span>: {r.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
  )
}
