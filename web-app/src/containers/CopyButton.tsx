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
      onClick={handleCopy}
    >
      {copied ? (
        <>
          <CopyCheck size={16} className="text-primary" />
        </>
      ) : (
        <Copy size={16} />
      )}
    </Button>
  )
}
