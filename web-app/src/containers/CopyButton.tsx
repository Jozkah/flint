import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

export const CopyButton = ({ text }: { text: string }) => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const handleCopy = async () => {
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="cp-pill h-7 w-auto min-w-7 gap-0 px-[7px] text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent data-[state=open]:bg-transparent data-[copied]:hover:bg-success/15 pointer-coarse:h-11 pointer-coarse:min-w-11"
          aria-label={t('chat:actions.copy')}
          data-copied={copied ? '' : undefined}
          onClick={handleCopy}
        >
          <span className="cp-ic" aria-hidden="true">
            <svg
              className="cs"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V6a2 2 0 0 1 2-2h9" />
            </svg>
            <svg
              className="ck"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12.5 10 17.5 19 7" pathLength={1} />
            </svg>
          </span>
          <span className="cp-lbl" aria-live="polite">
            <span className="cp-in text-xs font-medium">
              {copied ? t('chat:actions.copied') : ''}
            </span>
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('chat:actions.copy')}</TooltipContent>
    </Tooltip>
  )
}
