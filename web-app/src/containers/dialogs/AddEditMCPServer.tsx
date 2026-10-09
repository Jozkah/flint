import { useState, useEffect, useId } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Braces,
  GripVertical,
  OctagonAlert,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { STICKY_DIALOG_FOOTER } from '@/containers/dialogs/dialogLayout'
import { MCPServerConfig } from '@/hooks/useMCPServers'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  KeyboardSensor,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import CodeEditor from '@uiw/react-textarea-code-editor'
import '@uiw/react-textarea-code-editor/dist.css'
import {
  validateMcpServerForm,
  validateServerName,
  type McpFieldId,
  type McpValidationIssue,
} from '@/lib/mcpServerValidation'

/**
 * The message under one field: an error (blocks saving) or a warning (does
 * not). Rendered with the id the field's `aria-describedby` points at.
 */
function FieldMessage({
  id,
  issue,
}: {
  id: string
  issue: McpValidationIssue | undefined
}) {
  const { t } = useTranslation()
  if (!issue) return null
  const Icon = issue.severity === 'error' ? OctagonAlert : TriangleAlert
  return (
    <p
      id={id}
      className={cn(
        'flex items-start gap-1.5 text-xs',
        issue.severity === 'error'
          ? 'text-destructive'
          : 'text-warning'
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">{t(`mcp-servers:validation.${issue.code}`)}</span>
    </p>
  )
}

/**
 * A small icon action inside a form row (add, remove). A real button, so it is
 * reachable by keyboard and named for a screen reader; 44px on touch.
 */
function RowIconButton({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string
  onClick: () => void
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-hover-btn focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11 [&_svg]:size-4',
        destructive
          ? 'text-muted-foreground hover:text-destructive'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

// Sortable argument item component
function SortableArgItem({
  id,
  value,
  onChange,
  onRemove,
  canRemove,
  placeholder,
  inputId,
  describedBy,
  invalid,
}: {
  id: number
  value: string
  onChange: (value: string) => void
  onRemove: () => void
  canRemove: boolean
  placeholder: string
  inputId?: string
  describedBy?: string
  invalid?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-2 mb-2',
        isDragging ? 'z-10' : 'z-0'
      )}
    >
      <div
        {...attributes}
        {...listeners}
        className="flex size-8 shrink-0 cursor-move items-center justify-center rounded-md transition-colors hover:bg-hover-btn pointer-coarse:size-11"
      >
        <GripVertical className="size-4 text-muted-foreground" aria-hidden />
      </div>
      <Input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="min-w-0 flex-1"
      />
      {canRemove && (
        <RowIconButton label={placeholder} onClick={onRemove} destructive>
          <Trash2 aria-hidden />
        </RowIconButton>
      )}
    </div>
  )
}

interface AddEditMCPServerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingKey: string | null
  initialData?: MCPServerConfig
  onSave: (name: string, config: MCPServerConfig) => void
  /** Names already configured, so a new server cannot silently replace one. */
  existingNames?: string[]
}

export default function AddEditMCPServer({
  open,
  onOpenChange,
  editingKey,
  initialData,
  onSave,
  existingNames = [],
}: AddEditMCPServerProps) {
  const { t } = useTranslation()
  const idPrefix = useId()
  /** Errors stay hidden until the first save attempt, then track every edit. */
  const [attempted, setAttempted] = useState(false)
  const [serverName, setServerName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState<string[]>([''])
  const [envKeys, setEnvKeys] = useState<string[]>([''])
  const [envValues, setEnvValues] = useState<string[]>([''])
  const [transportType, setTransportType] = useState<'stdio' | 'http' | 'sse'>(
    'stdio'
  )
  const [url, setUrl] = useState('')
  const [headerKeys, setHeaderKeys] = useState<string[]>([''])
  const [headerValues, setHeaderValues] = useState<string[]>([''])
  const [timeout, setTimeout] = useState('')
  const [isToggled, setIsToggled] = useState(false)
  const [jsonContent, setJsonContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Reset form when modal opens/closes or editing key changes
  useEffect(() => {
    if (open && editingKey && initialData) {
      setServerName(editingKey)
      setCommand(initialData.command || '')
      setUrl(initialData.url || '')
      setTimeout(initialData.timeout ? initialData.timeout.toString() : '')
      setArgs(initialData.args?.length > 0 ? initialData.args : [''])
      setTransportType(initialData?.type || 'stdio')

      // Initialize JSON content for toggle mode
      try {
        const jsonData = { [editingKey]: initialData }
        setJsonContent(JSON.stringify(jsonData, null, 2))
      } catch {
        setJsonContent('')
      }

      if (initialData.env) {
        // Convert env object to arrays of keys and values
        const keys = Object.keys(initialData.env)
        const values = keys.map((key) => initialData.env[key])

        setEnvKeys(keys.length > 0 ? keys : [''])
        setEnvValues(values.length > 0 ? values : [''])
      }

      if (initialData.headers) {
        // Convert headers object to arrays of keys and values
        const headerKeysList = Object.keys(initialData.headers)
        const headerValuesList = headerKeysList.map(
          (key) => initialData.headers![key]
        )

        setHeaderKeys(headerKeysList.length > 0 ? headerKeysList : [''])
        setHeaderValues(headerValuesList.length > 0 ? headerValuesList : [''])
      }
    } else if (open) {
      // Add mode - reset form
      resetForm()
    }
  }, [open, editingKey, initialData])

  const resetForm = () => {
    setServerName('')
    setCommand('')
    setUrl('')
    setTimeout('')
    setArgs([''])
    setEnvKeys([''])
    setEnvValues([''])
    setHeaderKeys([''])
    setHeaderValues([''])
    setTransportType('stdio')
    setIsToggled(false)
    setJsonContent('')
    setError(null)
    setAttempted(false)
  }

  const handleAddArg = () => {
    setArgs([...args, ''])
  }

  const handleRemoveArg = (index: number) => {
    const newArgs = [...args]
    newArgs.splice(index, 1)
    setArgs(newArgs.length > 0 ? newArgs : [''])
  }

  const handleArgChange = (index: number, value: string) => {
    const newArgs = [...args]
    newArgs[index] = value
    setArgs(newArgs)
  }

  const handleReorderArgs = (oldIndex: number, newIndex: number) => {
    setArgs(arrayMove(args, oldIndex, newIndex))
  }

  // Sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 100,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor)
  )

  const handleAddEnv = () => {
    setEnvKeys([...envKeys, ''])
    setEnvValues([...envValues, ''])
  }

  const handleRemoveEnv = (index: number) => {
    const newKeys = [...envKeys]
    const newValues = [...envValues]
    newKeys.splice(index, 1)
    newValues.splice(index, 1)
    setEnvKeys(newKeys.length > 0 ? newKeys : [''])
    setEnvValues(newValues.length > 0 ? newValues : [''])
  }

  const handleEnvKeyChange = (index: number, value: string) => {
    const newKeys = [...envKeys]
    newKeys[index] = value
    setEnvKeys(newKeys)
  }

  const handleEnvValueChange = (index: number, value: string) => {
    const newValues = [...envValues]
    newValues[index] = value
    setEnvValues(newValues)
  }

  const handleAddHeader = () => {
    setHeaderKeys([...headerKeys, ''])
    setHeaderValues([...headerValues, ''])
  }

  const handleRemoveHeader = (index: number) => {
    const newKeys = [...headerKeys]
    const newValues = [...headerValues]
    newKeys.splice(index, 1)
    newValues.splice(index, 1)
    setHeaderKeys(newKeys.length > 0 ? newKeys : [''])
    setHeaderValues(newValues.length > 0 ? newValues : [''])
  }

  const handleHeaderKeyChange = (index: number, value: string) => {
    const newKeys = [...headerKeys]
    newKeys[index] = value
    setHeaderKeys(newKeys)
  }

  const handleHeaderValueChange = (index: number, value: string) => {
    const newValues = [...headerValues]
    newValues[index] = value
    setHeaderValues(newValues)
  }

  const validation = validateMcpServerForm(
    {
      name: serverName,
      transport: transportType,
      command,
      args,
      envKeys,
      envValues,
      url,
      headerKeys,
      headerValues,
      timeout,
    },
    { existingNames, editingKey }
  )

  const fieldId = (field: McpFieldId) =>
    `${idPrefix}-mcp-${field.replace('.', '-')}`
  const messageId = (field: McpFieldId) => `${fieldId(field)}-message`
  /** The issue to show for a field: errors after a save attempt, warnings always. */
  const issueFor = (field: McpFieldId): McpValidationIssue | undefined =>
    (attempted ? validation.errors[field] : undefined) ??
    validation.warnings[field]
  /** Accessibility attributes tying a field to its message. */
  const fieldA11y = (field: McpFieldId) => {
    const issue = issueFor(field)
    return {
      id: fieldId(field),
      'aria-invalid': issue?.severity === 'error' ? true : undefined,
      'aria-describedby': issue ? messageId(field) : undefined,
    }
  }

  const handleSave = () => {
    // Handle JSON mode
    if (isToggled) {
      try {
        const parsedData = JSON.parse(jsonContent)
        // Validate that it's an object with server configurations
        if (typeof parsedData !== 'object' || parsedData === null) {
          setError(t('mcp-servers:editJson.errorFormat'))
          return
        }
        // Check if this looks like a server config object instead of the expected format
        if (parsedData.command || parsedData.url) {
          setError(t('mcp-servers:editJson.errorMissingServerNameKey'))
          return
        }

        // Validate every entry before saving any, so a bad entry late in the
        // JSON does not leave the earlier ones half-applied.
        const entries: Array<[string, MCPServerConfig]> = []
        for (const [serverName, config] of Object.entries(parsedData)) {
          const trimmedServerName = serverName.trim()
          if (!trimmedServerName) {
            setError(t('mcp-servers:editJson.errorServerName'))
            return
          }

          // Validate the config object
          const serverConfig = config as MCPServerConfig

          // Validate type field if present
          if (
            serverConfig.type &&
            !['stdio', 'http', 'sse'].includes(serverConfig.type)
          ) {
            setError(
              t('mcp-servers:editJson.errorInvalidType', {
                serverName: trimmedServerName,
                type: serverConfig.type,
              })
            )
            return
          }

          // Same duplicate-name rule as the form: a pasted key that matches
          // another configured server would silently replace it.
          if (
            validateServerName(trimmedServerName, { existingNames, editingKey })
              ?.code === 'nameDuplicate'
          ) {
            setError(
              t('mcp-servers:editJson.errorNameDuplicate', {
                serverName: trimmedServerName,
              })
            )
            return
          }

          entries.push([trimmedServerName, serverConfig])
        }
        for (const [name, serverConfig] of entries) {
          onSave(name, serverConfig)
        }
        onOpenChange(false)
        resetForm()
        setError(null)
        return
      } catch {
        setError(t('mcp-servers:editJson.errorFormat'))
        return
      }
    }

    // Handle form mode: nothing is saved (and so nothing is started) until
    // every field that can be checked here is valid.
    setAttempted(true)
    if (!validation.valid) {
      if (validation.firstInvalidField) {
        document.getElementById(fieldId(validation.firstInvalidField))?.focus()
      }
      return
    }

    // Convert env arrays to object
    const envObj: Record<string, string> = {}
    envKeys.forEach((key, index) => {
      const keyName = key.trim()
      if (keyName !== '') {
        envObj[keyName] = envValues[index]?.trim() || ''
      }
    })

    // Convert headers arrays to object
    const headersObj: Record<string, string> = {}
    headerKeys.forEach((key, index) => {
      const keyName = key.trim()
      if (keyName !== '') {
        headersObj[keyName] = headerValues[index]?.trim() || ''
      }
    })

    // Filter out empty args
    const filteredArgs = args.map((arg) => arg.trim()).filter((arg) => arg)

    const config: MCPServerConfig = {
      ...(initialData || {}),
      command: transportType === 'stdio' ? command.trim() : '',
      args: transportType === 'stdio' ? filteredArgs : [],
      env: transportType === 'stdio' ? envObj : {},
      type: transportType,
      ...(transportType !== 'stdio' && {
        url: url.trim(),
        headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
        timeout: timeout.trim() !== '' ? parseInt(timeout) : undefined,
      }),
    }

    if (serverName.trim() !== '') {
      onSave(serverName.trim(), config)
      onOpenChange(false)
      resetForm()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] lg:max-w-[480px] xl:max-w-[480px]"
        showCloseButton={false}
        onInteractOutside={(e) => {
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>
              {editingKey
                ? t('mcp-servers:editServer')
                : t('mcp-servers:addServer')}
            </span>
            <button
              type="button"
              className={cn(
                'grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover-btn hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:size-11',
                isToggled && 'bg-accent text-foreground ring-1 ring-border'
              )}
              title="Add server by JSON"
              aria-label="Add server by JSON"
              aria-pressed={isToggled}
              onClick={() => setIsToggled(!isToggled)}
            >
              <Braces className="size-5" aria-hidden />
            </button>
          </DialogTitle>
        </DialogHeader>
        {isToggled ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm mb-2 inline-block">
                {t('mcp-servers:editJson.placeholder')}
              </label>
              <div className="overflow-hidden rounded-lg border border-border bg-muted">
                <CodeEditor
                  value={jsonContent}
                  language="json"
                  placeholder={`{
  "serverName": {
    "command": "command",
    "args": ["arg1", "arg2"],
    "env": {
      "KEY": "value"
    }
  }
}`}
                  onChange={(e) => {
                    setJsonContent(e.target.value)
                    setError(null)
                  }}
                  onPaste={() => setError(null)}
                  style={{
                    backgroundColor: 'transparent',
                    wordBreak: 'break-all',
                    overflowWrap: 'anywhere',
                    whiteSpace: 'pre-wrap',
                  }}
                  className="w-full text-sm! min-h-[300px] font-mono!"
                />
              </div>
              {error && (
                <div role="alert" className="flex items-start gap-2 text-destructive text-sm">
                  <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 break-words">{error}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor={fieldId('name')}
                className="text-sm mb-2 inline-block"
              >
                {t('mcp-servers:serverName')}
              </label>
              <Input
                {...fieldA11y('name')}
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder={t('mcp-servers:enterServerName')}
                autoFocus
              />
              <FieldMessage id={messageId('name')} issue={issueFor('name')} />
            </div>

            <div className="space-y-2">
              <label className="text-sm mb-2 inline-block">
                Transport Type
              </label>
              <RadioGroup
                value={transportType}
                onValueChange={(value) =>
                  setTransportType(value as 'http' | 'sse')
                }
                className="flex flex-col gap-1"
              >
                <label htmlFor="stdio" className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-border px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-hover-row has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-hover-btn sm:min-h-9">
                  <RadioGroupItem value="stdio" id="stdio" />
                  STDIO
                </label>
                <label htmlFor="http" className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-border px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-hover-row has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-hover-btn sm:min-h-9">
                  <RadioGroupItem value="http" id="http" />
                  HTTP
                </label>
                <label htmlFor="sse" className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-[0.8px] border-border px-2.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-hover-row has-[[data-state=checked]]:border-border-strong has-[[data-state=checked]]:bg-hover-btn sm:min-h-9">
                  <RadioGroupItem value="sse" id="sse" />
                  SSE
                </label>
              </RadioGroup>
            </div>

            {transportType === 'stdio' ? (
              <div className="space-y-2">
                <label
                  htmlFor={fieldId('command')}
                  className="text-sm mb-2 inline-block"
                >
                  {t('mcp-servers:command')}
                </label>
                <Input
                  {...fieldA11y('command')}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={t('mcp-servers:enterCommand')}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('mcp-servers:commandHint')}
                </p>
                <FieldMessage
                  id={messageId('command')}
                  issue={issueFor('command')}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <label
                  htmlFor={fieldId('url')}
                  className="text-sm mb-2 inline-block"
                >
                  URL
                </label>
                <Input
                  {...fieldA11y('url')}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Enter URL"
                />
                <FieldMessage id={messageId('url')} issue={issueFor('url')} />
              </div>
            )}

            {transportType === 'stdio' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm">
                    {t('mcp-servers:arguments')}
                  </label>
                  <RowIconButton
                    label={t('mcp-servers:arguments')}
                    onClick={handleAddArg}
                  >
                    <Plus aria-hidden />
                  </RowIconButton>
                </div>

                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(event) => {
                    const { active, over } = event
                    if (active.id !== over?.id) {
                      const oldIndex = parseInt(active.id.toString())
                      const newIndex = parseInt(over?.id.toString() || '0')
                      handleReorderArgs(oldIndex, newIndex)
                    }
                  }}
                >
                  <SortableContext
                    items={args.map((_, index) => index)}
                    strategy={verticalListSortingStrategy}
                  >
                    {args.map((arg, index) => {
                      const field: McpFieldId = `args.${index}`
                      const issue = issueFor(field)
                      return (
                        <div key={index}>
                          <SortableArgItem
                            id={index}
                            value={arg}
                            onChange={(value) => handleArgChange(index, value)}
                            onRemove={() => handleRemoveArg(index)}
                            canRemove={args.length > 1}
                            placeholder={t('mcp-servers:argument', {
                              index: index + 1,
                            })}
                            inputId={fieldId(field)}
                            invalid={issue?.severity === 'error'}
                            describedBy={issue ? messageId(field) : undefined}
                          />
                          <FieldMessage id={messageId(field)} issue={issue} />
                        </div>
                      )
                    })}
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {transportType === 'stdio' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm">{t('mcp-servers:envVars')}</label>
                  <RowIconButton
                    label={t('mcp-servers:envVars')}
                    onClick={handleAddEnv}
                  >
                    <Plus aria-hidden />
                  </RowIconButton>
                </div>

                {envKeys.map((key, index) => (
                  <div key={`env-${index}`}>
                  <div className="flex items-center gap-2">
                    <Input
                      {...fieldA11y(`env.${index}`)}
                      value={key}
                      onChange={(e) =>
                        handleEnvKeyChange(index, e.target.value)
                      }
                      placeholder={t('mcp-servers:key')}
                      aria-label={t('mcp-servers:key')}
                      className="min-w-0 flex-1 font-mono"
                    />
                    <Input
                      value={envValues[index] || ''}
                      onChange={(e) =>
                        handleEnvValueChange(index, e.target.value)
                      }
                      placeholder={t('mcp-servers:value')}
                      className="min-w-0 flex-1"
                    />
                    {envKeys.length > 1 && (
                      <RowIconButton
                        label={`${t('mcp-servers:envVars')} ${index + 1}`}
                        onClick={() => handleRemoveEnv(index)}
                        destructive
                      >
                        <Trash2 aria-hidden />
                      </RowIconButton>
                    )}
                  </div>
                  <FieldMessage
                    id={messageId(`env.${index}`)}
                    issue={issueFor(`env.${index}`)}
                  />
                  </div>
                ))}
              </div>
            )}

            {(transportType === 'http' || transportType === 'sse') && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm">Headers</label>
                    <RowIconButton label="Headers" onClick={handleAddHeader}>
                      <Plus aria-hidden />
                    </RowIconButton>
                  </div>

                  {headerKeys.map((key, index) => (
                    <div key={`header-${index}`}>
                    <div className="flex items-center gap-2">
                      <Input
                        {...fieldA11y(`header.${index}`)}
                        value={key}
                        onChange={(e) =>
                          handleHeaderKeyChange(index, e.target.value)
                        }
                        placeholder="Header name"
                        aria-label="Header name"
                        className="min-w-0 flex-1 font-mono"
                      />
                      <Input
                        value={headerValues[index] || ''}
                        onChange={(e) =>
                          handleHeaderValueChange(index, e.target.value)
                        }
                        placeholder="Header value"
                        className="min-w-0 flex-1"
                      />
                      {headerKeys.length > 1 && (
                        <RowIconButton
                          label={`Header ${index + 1}`}
                          onClick={() => handleRemoveHeader(index)}
                          destructive
                        >
                          <Trash2 aria-hidden />
                        </RowIconButton>
                      )}
                    </div>
                    <FieldMessage
                      id={messageId(`header.${index}`)}
                      issue={issueFor(`header.${index}`)}
                    />
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor={fieldId('timeout')}
                    className="text-sm mb-2 inline-block"
                  >
                    Timeout (seconds)
                  </label>
                  <Input
                    {...fieldA11y('timeout')}
                    value={timeout}
                    onChange={(e) => setTimeout(e.target.value)}
                    placeholder="Enter timeout in seconds"
                    type="number"
                  />
                  <FieldMessage
                    id={messageId('timeout')}
                    issue={issueFor('timeout')}
                  />
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter className={STICKY_DIALOG_FOOTER}>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => onOpenChange(false)}
          >
            {t('common:cancel')}
          </Button>
          <Button
            onClick={handleSave}
            size="sm"
            className="pointer-coarse:h-11"
            disabled={!isToggled && serverName.trim() === ''}
          >
            {t('mcp-servers:save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
