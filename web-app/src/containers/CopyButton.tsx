import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Copy, CopyCheck } from 'lucide-react'
import { useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

export const CopyButton = ({ text }: { text: string }) => {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent data-[state=open]:bg-transparent pointer-coarse:size-11"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <CopyCheck className="size-3.5 text-primary" />
            </>
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('chat:actions.copy')}</TooltipContent>
    </Tooltip>
  )
}
