import { Button } from '@/components/ui/button'
import { Copy, CopyCheck } from 'lucide-react'
import { useState } from 'react'

export const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-7 text-fg-2 hover:bg-transparent hover:text-foreground dark:hover:bg-transparent data-[state=open]:bg-transparent pointer-coarse:size-11"
      onClick={handleCopy}
    >
      {copied ? (
        <>
          <CopyCheck className="size-4 text-primary" />
        </>
      ) : (
        <Copy className="size-4" />
      )}
    </Button>
  )
}
