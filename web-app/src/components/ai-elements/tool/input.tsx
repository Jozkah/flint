/* eslint-disable react-refresh/only-export-components */
import { cn } from '@/lib/utils'
import type { ToolUIPart } from 'ai'
import type { ComponentProps } from 'react'
import { Fragment, memo, useMemo, useState } from 'react'
import { CodeBlock } from '../code-block'
import { CopyButton } from '@/containers/CopyButton'
import { isPlainObject, parseToolInput, stringifyToolInput } from '@/lib/toolInputSummary'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { OpenablePath } from '@/containers/message/OpenablePath'
import { lineOfToolInput } from '@/lib/codeOpen'
import { TOOL_SECTION, MINI_TRACK, miniOption } from './shared'

export type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input']
}

/** Parameters that name one file, the way the workspace tools spell it. */
const PATH_PARAMS = new Set(['path', 'file_path', 'filePath'])

/** Table cells keep nested values readable rather than collapsing them. */
const formatParamValue = (value: unknown): string =>
  typeof value === 'string' ? value : stringifyToolInput(value)

export const ToolInput = memo(
  ({ className, input, ...props }: ToolInputProps) => {
    const { t } = useTranslation()
    const [showRaw, setShowRaw] = useState(false)

    const parsed = useMemo(() => parseToolInput(input), [input])
    const formatted = useMemo(() => stringifyToolInput(parsed), [parsed])
    const rows = useMemo(
      () => (isPlainObject(parsed) ? Object.entries(parsed) : []),
      [parsed]
    )
    const asTable = rows.length > 0 && !showRaw

    return (
      <div className={cn(TOOL_SECTION, 'space-y-2', className)} {...props}>
        <div className="flex min-h-6 items-center gap-2">
          <h4 className="flex-1 text-xs font-medium text-fg-2">
            {t('tools:toolCall.parameters')}
          </h4>
          {rows.length > 0 && (
            <span className={MINI_TRACK}>
              <button
                type="button"
                aria-pressed={!showRaw}
                className={miniOption(!showRaw)}
                onClick={() => setShowRaw(false)}
              >
                {t('tools:toolCall.viewTable')}
              </button>
              <button
                type="button"
                aria-pressed={showRaw}
                className={miniOption(showRaw)}
                onClick={() => setShowRaw(true)}
              >
                {t('tools:toolCall.viewRaw')}
              </button>
            </span>
          )}
          <CopyButton text={formatted} />
        </div>
        {asTable ? (
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-3.5 gap-y-1.5 text-xs">
            {rows.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="max-w-32 truncate text-muted-foreground">
                  {key}
                </dt>
                <dd className="min-w-0 max-h-24 overflow-auto">
                  <code className="block rounded-[5px] bg-accent px-[5px] py-px font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
                    {PATH_PARAMS.has(key) &&
                    typeof value === 'string' &&
                    value.trim() ? (
                      // The path argument opens in the Code panel where
                      // there is one; elsewhere it stays text.
                      <OpenablePath
                        path={value}
                        line={lineOfToolInput(parsed)}
                      />
                    ) : (
                      formatParamValue(value)
                    )}
                  </code>
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <div className="max-h-40 overflow-auto rounded-lg bg-code-bg shadow-[inset_0_0_0_0.8px_var(--border)]">
            <CodeBlock code={formatted} language="json" />
          </div>
        )}
      </div>
    )
  }
)

ToolInput.displayName = 'ToolInput'

