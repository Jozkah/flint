import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { OctagonAlert } from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { MCPServerConfig, MCPServers, MCPSettings } from '@/hooks/useMCPServers'
import CodeEditor from '@uiw/react-textarea-code-editor'
import '@uiw/react-textarea-code-editor/dist.css'
import { useTranslation } from '@/i18n/react-i18next-compat'

type MCPConfigJson =
  | MCPServerConfig
  | MCPServers
  | {
      mcpServers: MCPServers
      mcpSettings?: MCPSettings
    }

interface EditJsonMCPserverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverName: string | null // null means editing all servers
  initialData: MCPConfigJson
  onSave: (data: MCPConfigJson) => void
}

export default function EditJsonMCPserver({
  open,
  onOpenChange,
  serverName,
  initialData,
  onSave,
}: EditJsonMCPserverProps) {
  const { t } = useTranslation()
  const [jsonContent, setJsonContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Initialize the editor with the provided data
  useEffect(() => {
    if (open && initialData) {
      try {
        setJsonContent(JSON.stringify(initialData, null, 2))
        setError(null)
      } catch {
        setError(t('mcp-servers:editJson.errorParse'))
      }
    }
  }, [open, initialData, t])

  const handlePaste = () => {
    // Clear any existing errors when pasting
    setError(null)
  }

  const handleSave = () => {
    try {
      const parsedData = JSON.parse(jsonContent) as MCPConfigJson
      onSave(parsedData)
      onOpenChange(false)
      setError(null)
    } catch {
      setError(t('mcp-servers:editJson.errorFormat'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onInteractOutside={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {serverName
              ? t('mcp-servers:editJson.title', { serverName })
              : t('mcp-servers:editJson.titleAll')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="overflow-hidden! rounded-md border border-border bg-sunken">
            <style>{`
              .w-tc-editor textarea {
                word-break: break-all !important;
                overflow-wrap: anywhere !important;
                white-space: pre-wrap !important;
              }
              .w-tc-editor .token.string {
                word-break: break-all !important;
                overflow-wrap: anywhere !important;
              }
            `}</style>
            <CodeEditor
              value={jsonContent}
              language="json"
              placeholder={t('mcp-servers:editJson.placeholder')}
              onChange={(e) => setJsonContent(e.target.value)}
              onPaste={handlePaste}
              style={{
                backgroundColor: 'transparent',
                wordBreak: 'break-all',
                overflowWrap: 'anywhere',
                whiteSpace: 'pre-wrap',
              }}
              className="w-full text-sm! overflow-hidden break-all! font-mono!"
            />
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 text-destructive text-sm">
              <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button size="sm" className="pointer-coarse:h-11" onClick={handleSave}>{t('mcp-servers:editJson.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
