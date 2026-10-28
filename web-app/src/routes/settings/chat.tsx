import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  SettingsPageBody,
  SettingsPageHeader,
} from '@/containers/SettingsPageHeader'
import {
  SettingsTabStrip,
  useSettingsTab,
  type SettingsTab,
} from '@/containers/SettingsTabs'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import ReplyLanguageSwitcher from '@/containers/ReplyLanguageSwitcher'
import { VisualizeSettings } from '@/containers/VisualizeSettings'
import { ChatRulesCard } from '@/containers/ChatRulesCard'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useWebPreviewSettings } from '@/hooks/useWebPreviewSettings'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { useCoworkDisplay } from '@/hooks/useCoworkDisplay'
import { TRANSCRIPT_VIEWS } from '@/lib/transcriptView'
import {
  REASONING_DEFAULTS,
  isReasoningDefault,
  type ReasoningDefault,
} from '@/lib/reasoningDefault'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { McpRouterModelPicker } from '@/containers/McpRouterModelPicker'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTitleSettings } from '@/hooks/useTitleSettings'
import { DEFAULT_TITLE_PROMPT } from '@/lib/thread-title-summarizer'


export const Route = createFileRoute(route.settings.chat)({
  component: ChatSettings,
})

type ChatTab = 'input' | 'display'

function ChatSettings() {
  const { t } = useTranslation()
  const tabs: SettingsTab<ChatTab>[] = [
    {
      id: 'input',
      label: t('settings:chat.tabInput', { defaultValue: 'Input and replies' }),
      anchors: [
        'settings-chat-enter-newline',
        'settings-chat-spell-check',
        'settings-chat-composer-rail-buttons',
        'settings-chat-reply-language',
        'settings-chat-auto-title',
        'settings-chat-strip-reasoning',
        'settings-chat-reasoning-default',
        'settings-chat-web-preview',
        'settings-chat-rules',
      ],
    },
    {
      id: 'display',
      label: t('settings:chat.tabDisplay', { defaultValue: 'Display' }),
      anchors: [
        'settings-chat-transcript-view',
        'settings-chat-token-speed',
        'settings-chat-user-markdown',
        'settings-chat-wrap-code-lines',
        'settings-chat-inline-citations',
        'settings-chat-hide-completed',
        'settings-chat-model-received',
        'settings-chat-html-artifacts',
        'settings-agent-tools-visualize',
        'settings-chat-reset',
      ],
    },
  ]
  const [tab, setTab] = useSettingsTab(tabs)

  return (
    <div className="flex h-full w-full flex-col">
      <SettingsPageHeader title={t('common:settingsChat')} />
      <SettingsPageBody
        title={t('common:settingsChat')}
        description={t('settings:pageDesc.chat')}
        actions={
          <SettingsTabStrip
            tabs={tabs}
            value={tab}
            onChange={setTab}
            label={t('common:settingsChat')}
          />
        }
        // Slots count hidden groups, so each tab keeps its own columns.
        layout={[0, 1, 1, 2, 0, 1, 1, 1]}
      >
        {tab === 'input' && <ComposerCard />}
        {tab === 'input' && <RepliesCard />}
        {tab === 'input' && <LinksCard />}
        {tab === 'input' && <ChatRulesCard />}
        {tab === 'display' && <TranscriptCard />}
        {tab === 'display' && <ArtifactsCard />}
        {tab === 'display' && <VisualizeSettings />}
        {tab === 'display' && <ResetCard />}
      </SettingsPageBody>
    </div>
  )
}

function ComposerCard() {
  const { t } = useTranslation()
  const spellCheckChatInput = useGeneralSetting((s) => s.spellCheckChatInput)
  const setSpellCheckChatInput = useGeneralSetting(
    (s) => s.setSpellCheckChatInput
  )
  const enterKeyInsertsNewline = useGeneralSetting(
    (s) => s.enterKeyInsertsNewline
  )
  const setEnterKeyInsertsNewline = useGeneralSetting(
    (s) => s.setEnterKeyInsertsNewline
  )
  const showComposerRailButtons = useInterfaceSettings(
    (s) => s.showComposerRailButtons
  )
  const setShowComposerRailButtons = useInterfaceSettings(
    (s) => s.setShowComposerRailButtons
  )
  return (
    <Card title={t('settings:chat.composerGroup', { defaultValue: 'Composer' })}>
      <CardItem
        anchor="settings-chat-enter-newline"
        title={t('settings:others.enterKeyNewline', {
          ns: 'settings',
        })}
        description={t('settings:others.enterKeyNewlineDesc', {
          ns: 'settings',
        })}
        actions={
          <Switch
            checked={enterKeyInsertsNewline}
            onCheckedChange={(e) => setEnterKeyInsertsNewline(e)}
          />
        }
      />
      <CardItem
        anchor="settings-chat-spell-check"
        title={t('settings:others.spellCheck', {
          ns: 'settings',
        })}
        description={
          <span className="flex flex-col gap-1">
            <span>
              {t('settings:others.spellCheckDesc', {
                ns: 'settings',
              })}
            </span>
            <span className="text-subtle-foreground">
              {t('settings:others.spellCheckHint')}
            </span>
          </span>
        }
        actions={
          <Switch
            checked={spellCheckChatInput}
            onCheckedChange={(e) => setSpellCheckChatInput(e)}
          />
        }
      />
      <CardItem
        anchor="settings-chat-composer-rail-buttons"
        title={t('settings:interface.composerRailButtons')}
        description={t('settings:interface.composerRailButtonsDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.composerRailButtons')}
            data-testid="composer-rail-buttons-switch"
            checked={Boolean(showComposerRailButtons)}
            onCheckedChange={(v) => setShowComposerRailButtons?.(v)}
          />
        }
      />
    </Card>
  )
}

function RepliesCard() {
  const { t } = useTranslation()
  const autoGenerateTitle = useInterfaceSettings((s) => s.autoGenerateTitle)
  const setAutoGenerateTitle = useInterfaceSettings(
    (s) => s.setAutoGenerateTitle
  )
  const stripReasoningFromContext = useGeneralSetting(
    (s) => s.stripReasoningFromContext
  )
  const setStripReasoningFromContext = useGeneralSetting(
    (s) => s.setStripReasoningFromContext
  )
  return (
    <Card title={t('settings:chat.repliesGroup', { defaultValue: 'Replies' })}>
      <CardItem
        anchor="settings-chat-reply-language"
        title={t('settings:general.replyLanguage')}
        description={t('settings:general.replyLanguageDesc')}
        actions={<ReplyLanguageSwitcher />}
      />
      <CardItem
        anchor="settings-chat-auto-title"
        title={t('settings:interface.autoGenerateTitle')}
        description={t('settings:interface.autoGenerateTitleDesc')}
        actions={
          <Switch
            checked={autoGenerateTitle}
            onCheckedChange={setAutoGenerateTitle}
          />
        }
      />
      {autoGenerateTitle && <TitleModelAndPrompt />}
      <CardItem
        anchor="settings-chat-strip-reasoning"
        title={t('provider:stripReasoning')}
        description={t('provider:stripReasoningDesc')}
        actions={
          <Switch
            aria-label={t('provider:stripReasoning')}
            checked={stripReasoningFromContext}
            onCheckedChange={setStripReasoningFromContext}
          />
        }
      />
      <CardItem
        anchor="settings-chat-reasoning-default"
        title={t('settings:chat.reasoningDefault')}
        description={t('settings:chat.reasoningDefaultDesc')}
        actions={<ReasoningDefaultPicker />}
      />
    </Card>
  )
}

function ReasoningDefaultPicker() {
  const { t } = useTranslation()
  const value = useGeneralSetting((s) => s.reasoningDefault)
  const setValue = useGeneralSetting((s) => s.setReasoningDefault)
  const label: Record<ReasoningDefault, string> = {
    model: t('settings:chat.reasoningDefaultModel'),
    on: t('settings:chat.reasoningDefaultOn'),
    off: t('settings:chat.reasoningDefaultOff'),
  }
  return (
    <RadioGroup
      value={value ?? 'model'}
      onValueChange={(v) => isReasoningDefault(v) && setValue(v)}
      aria-label={t('settings:chat.reasoningDefault')}
      data-testid="reasoning-default-picker"
      className="flex flex-wrap gap-3"
    >
      {REASONING_DEFAULTS.map((mode) => {
        const id = `reasoning-default-${mode}`
        return (
          <label
            key={mode}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-1.5 text-sm"
          >
            <RadioGroupItem id={id} value={mode} />
            {label[mode]}
          </label>
        )
      })}
    </RadioGroup>
  )
}

/** Which model writes automatic titles, and with what prompt (janhq/jan#8345). */
function TitleModelAndPrompt() {
  const { t } = useTranslation()
  const providers = useModelProvider((s) => s.providers)
  const titleModelProvider = useTitleSettings((s) => s.titleModelProvider)
  const titleModelId = useTitleSettings((s) => s.titleModelId)
  const titlePrompt = useTitleSettings((s) => s.titlePrompt)
  const setTitleModel = useTitleSettings((s) => s.setTitleModel)
  const setTitlePrompt = useTitleSettings((s) => s.setTitlePrompt)
  const usesChatModel = !titleModelProvider || !titleModelId
  return (
    <>
      <CardItem
        anchor="settings-chat-title-model"
        title={t('settings:interface.titleModel')}
        description={t('settings:interface.titleModelDesc')}
        actions={
          <div className="flex items-center gap-2">
            {!usesChatModel && (
              <Button
                variant="link"
                size="sm"
                onClick={() => setTitleModel('', '')}
              >
                {t('settings:interface.titleModelDefault')}
              </Button>
            )}
            <McpRouterModelPicker
              ariaLabel={t('settings:interface.titleModel')}
              providers={providers}
              selectedProvider={titleModelProvider}
              selectedModelId={titleModelId}
              onSelect={setTitleModel}
              placeholder={t('settings:interface.titleModelDefault')}
              searchPlaceholder={t('settings:interface.titleModelSearch')}
              emptyListMessage={t('settings:interface.titleModelEmpty')}
              formatEmptySearch={(q) =>
                t('settings:interface.titleModelEmptySearch', { query: q })
              }
            />
          </div>
        }
      />
      <CardItem
        anchor="settings-chat-title-prompt"
        title={t('settings:interface.titlePrompt')}
        description={t('settings:interface.titlePromptDesc')}
        actions={
          titlePrompt.trim() ? (
            <Button variant="link" size="sm" onClick={() => setTitlePrompt('')}>
              {t('settings:interface.titlePromptReset')}
            </Button>
          ) : undefined
        }
      />
      <Textarea
        aria-label={t('settings:interface.titlePrompt')}
        value={titlePrompt || DEFAULT_TITLE_PROMPT}
        onChange={(e) =>
          setTitlePrompt(
            e.target.value === DEFAULT_TITLE_PROMPT ? '' : e.target.value
          )
        }
        rows={3}
        className="mb-2 text-sm"
      />
    </>
  )
}

function LinksCard() {
  const { t } = useTranslation()
  const interceptLinks = useWebPreviewSettings((s) => s.interceptLinks)
  const setInterceptLinks = useWebPreviewSettings((s) => s.setInterceptLinks)
  return (
    <Card title={t('settings:chat.linksGroup', { defaultValue: 'Links' })}>
      <CardItem
        anchor="settings-chat-web-preview"
        title={t('common:webPreview.interceptSetting')}
        description={t('common:webPreview.interceptSettingDesc')}
        actions={
          <Switch
            checked={interceptLinks}
            onCheckedChange={(e) => setInterceptLinks(e)}
          />
        }
      />
    </Card>
  )
}

function TranscriptCard() {
  const { t } = useTranslation()
  const showTokenSpeed = useInterfaceSettings((s) => s.showTokenSpeed)
  const setShowTokenSpeed = useInterfaceSettings((s) => s.setShowTokenSpeed)
  const renderUserMarkdown = useInterfaceSettings((s) => s.renderUserMarkdown)
  const setRenderUserMarkdown = useInterfaceSettings(
    (s) => s.setRenderUserMarkdown
  )
  const wrapCodeLines = useInterfaceSettings((s) => s.wrapCodeLines)
  const setWrapCodeLines = useInterfaceSettings((s) => s.setWrapCodeLines)
  const showInlineCitations = useInterfaceSettings(
    (s) => s.showInlineCitations
  )
  const setShowInlineCitations = useInterfaceSettings(
    (s) => s.setShowInlineCitations
  )
  const hideCompletedTools = useCoworkDisplay((x) => x.hideCompletedTools)
  const setHideCompletedTools = useCoworkDisplay(
    (x) => x.setHideCompletedTools
  )
  const showPromptSnapshot = useCoworkDisplay((x) => x.showPromptSnapshot)
  const setShowPromptSnapshot = useCoworkDisplay(
    (x) => x.setShowPromptSnapshot
  )
  return (
    <Card title={t('settings:interface.transcriptView')}>
      <CardItem
        anchor="settings-chat-transcript-view"
        title={t('settings:interface.transcriptView')}
        description={t('settings:interface.transcriptViewDesc')}
      />
      <TranscriptViewPicker />
      <CardItem
        anchor="settings-chat-token-speed"
        title={t('settings:interface.showTokenSpeed')}
        description={t('settings:interface.showTokenSpeedDesc')}
        actions={
          <Switch checked={showTokenSpeed} onCheckedChange={setShowTokenSpeed} />
        }
      />
      <CardItem
        anchor="settings-chat-user-markdown"
        title={t('settings:interface.renderUserMarkdown')}
        description={t('settings:interface.renderUserMarkdownDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.renderUserMarkdown')}
            data-testid="render-user-markdown-switch"
            checked={renderUserMarkdown}
            onCheckedChange={setRenderUserMarkdown}
          />
        }
      />
      <CardItem
        anchor="settings-chat-wrap-code-lines"
        title={t('settings:interface.wrapCodeLines')}
        description={t('settings:interface.wrapCodeLinesDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.wrapCodeLines')}
            checked={wrapCodeLines}
            onCheckedChange={setWrapCodeLines}
          />
        }
      />
      <CardItem
        anchor="settings-chat-inline-citations"
        title={t('settings:interface.inlineCitations')}
        description={t('settings:interface.inlineCitationsDesc')}
        actions={
          <Switch
            aria-label={t('settings:interface.inlineCitations')}
            checked={showInlineCitations}
            onCheckedChange={setShowInlineCitations}
          />
        }
      />
      {/* Nothing is deleted: hidden activity stays in the session, in
          exports and in search. */}
      <CardItem
        anchor="settings-chat-hide-completed"
        title={t('common:coworkDisplay.hideCompletedTools')}
        description={t('common:coworkDisplay.hideCompletedToolsDescription')}
        align="start"
        actions={
          <Switch
            data-testid="hide-completed-tools"
            checked={hideCompletedTools}
            onCheckedChange={setHideCompletedTools}
          />
        }
      />
      {/* The per-turn record of the request; still recorded when off,
          and reachable from the session's details and timeline. */}
      <CardItem
        anchor="settings-chat-model-received"
        title={t('common:coworkDisplay.showModelReceived')}
        description={t('common:coworkDisplay.showModelReceivedDescription')}
        align="start"
        actions={
          <Switch
            data-testid="show-model-received"
            checked={showPromptSnapshot}
            onCheckedChange={setShowPromptSnapshot}
          />
        }
      />
    </Card>
  )
}

function ArtifactsCard() {
  const { t } = useTranslation()
  const renderHtmlArtifacts = useInterfaceSettings(
    (s) => s.renderHtmlArtifacts
  )
  const setRenderHtmlArtifacts = useInterfaceSettings(
    (s) => s.setRenderHtmlArtifacts
  )
  return (
    <Card
      title={t('settings:chat.artifactsGroup', {
        defaultValue: 'Artifacts and widgets',
      })}
    >
      <CardItem
        anchor="settings-chat-html-artifacts"
        title={
          <span className="inline-flex flex-wrap items-baseline gap-1.5">
            <span>{t('settings:interface.renderHtmlArtifacts')}</span>
            <span className="text-[length:calc(var(--ui-font-base)*0.65625)] font-normal text-subtle-foreground">
              {t('common:experimental')}
            </span>
          </span>
        }
        description={t('settings:interface.renderHtmlArtifactsDesc')}
        actions={
          <Switch
            checked={renderHtmlArtifacts}
            onCheckedChange={setRenderHtmlArtifacts}
          />
        }
      />
    </Card>
  )
}

/** Restores the transcript and reply display settings this page holds. */
function ResetCard() {
  const { t } = useTranslation()
  const resetChatDisplay = useInterfaceSettings((s) => s.resetChatDisplay)
  return (
    <Card title={t('settings:appearance.resetGroup')}>
      <CardItem
        anchor="settings-chat-reset"
        title={t('settings:interface.resetToDefault')}
        description={t('settings:interface.resetToDefaultDesc')}
        actions={
          <Button
            variant="destructive"
            className="pointer-coarse:h-11"
            data-testid="chat-reset"
            onClick={() => {
              resetChatDisplay()
              toast.success(t('settings:interface.resetInterfaceSuccess'), {
                id: 'reset-chat-display',
                description: t('settings:interface.resetInterfaceSuccessDesc'),
              })
            }}
          >
            {t('common:reset')}
          </Button>
        }
      />
    </Card>
  )
}

/** The Transcript view setting: one radio per mode, each with its summary. */
function TranscriptViewPicker() {
  const { t } = useTranslation()
  const value = useInterfaceSettings((s) => s.transcriptView)
  const setValue = useInterfaceSettings((s) => s.setTranscriptView)
  const label = {
    normal: t('settings:interface.transcriptViewNormal'),
    thinking: t('settings:interface.transcriptViewThinking'),
    verbose: t('settings:interface.transcriptViewVerbose'),
  }
  const desc = {
    normal: t('settings:interface.transcriptViewNormalDesc'),
    thinking: t('settings:interface.transcriptViewThinkingDesc'),
    verbose: t('settings:interface.transcriptViewVerboseDesc'),
  }
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => setValue(v as typeof value)}
      aria-label={t('settings:interface.transcriptView')}
      data-testid="transcript-view-picker"
      className="gap-2 pb-2"
    >
      {TRANSCRIPT_VIEWS.map((mode) => {
        const id = `transcript-view-${mode}`
        return (
          <label
            key={mode}
            htmlFor={id}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5"
          >
            <RadioGroupItem
              id={id}
              value={mode}
              aria-describedby={`${id}-desc`}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {label[mode]}
              </span>
              <span id={`${id}-desc`} className="text-xs text-muted-foreground">
                {desc[mode]}
              </span>
            </span>
          </label>
        )
      })}
    </RadioGroup>
  )
}
