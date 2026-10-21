import { Outlet, useNavigate } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { ModelReplaceDialog } from '@/containers/ModelReplaceDialog'
import { UnknownWindowDialog } from '@/containers/rooms/UnknownWindowDialog'
import { Fragment } from 'react/jsx-runtime'
import { MotionConfig } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useShellMotion } from '@/components/shell/useShellMotion'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { UsageActivityRecorder } from '@/providers/UsageActivityRecorder'
import { ActiveModelsSync } from '@/providers/ActiveModelsSync'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { CommandPalette } from '@/containers/CommandPalette'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useClearSettingsSearchOnExit } from '@/hooks/useSettingsSearch'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AccessRequestDialog from '@/containers/dialogs/AccessRequestDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { McpElicitationCard } from '@/containers/McpElicitationCard'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { WebPreviewHost } from '@/containers/WebPreviewHost'
import { BrowserDomainDialog } from '@/containers/BrowserDomainDialog'
import { WindowControls } from '@/components/WindowControls'
import { AppSidebar } from '@/components/shell/AppSidebar'
import { prewarmSoloWindow } from '@/lib/chatWindow'
import { TopHeader } from '@/components/shell/TopHeader'
import { ShellNavProvider } from '@/components/shell/nav-kit'
import { HeaderSlotProvider } from '@/components/shell/HeaderSlot'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import BypassConfirmDialog from '@/containers/dialogs/BypassConfirmDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import { EngineAddonOffer } from '@/containers/EngineAddon'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { MigrationAssistant } from '@/containers/MigrationAssistant'
import { TemporaryChatGuard } from '@/containers/TemporaryChatGuard'
import { useWindowTitle } from '@/hooks/useWindowTitle'
import { useAppViewport } from '@/hooks/useAppViewport'
import { useApprovalWaitNotifier } from '@/hooks/useApprovalWaitNotifier'
import { useRemoteBridge } from '@/hooks/useRemoteBridge'
import { useBuildUpdateCheck } from '@/hooks/useBuildUpdate'
import { RemotePairingConfirm } from '@/containers/RemotePairingConfirm'
import { FlintServerAutoConnect } from '@/containers/FlintServerAutoConnect'
import { detectWindowChrome } from '@/lib/titlebar'
import { CampaignRunHost } from '@/containers/CampaignRunHost'
import { ServerFolderPickerHost } from '@/containers/ServerFolderChooser'
import { ServerOfflineBanner } from '@/containers/ServerOfflineBanner'

/**
 * The app shell: the sidebar (on narrow windows a navigation sheet) beside the
 * main panel, a card-coloured surface holding the top header and the page.
 * Pages supply their header controls through HeaderPage and their content
 * through the router outlet.
 */
const AppLayout = () => {
  // The settings-search query outlives each settings page on purpose; it must
  // not outlive the section. Mounted here because this layout stays put.
  useClearSettingsSearchOnExit()
  useWindowTitle()
  useAppViewport()
  useApprovalWaitNotifier(useNavigate())
  // Remote access: answers paired phones and asks to confirm new ones.
  useRemoteBridge()
  useBuildUpdateCheck()
  const appDrawsChrome = detectWindowChrome() === 'custom'
  // Keep a hidden, booted window ready for "Open in new window" once the app
  // has settled, so that action shows a conversation without a cold start.
  useEffect(() => {
    if (!IS_TAURI) return
    const timer = setTimeout(() => void prewarmSoloWindow(), 4000)
    return () => clearTimeout(timer)
  }, [])
  const pageRef = useRef<HTMLDivElement>(null)
  const { booting } = useShellMotion(pageRef)

  return (
    <ShellNavProvider>
      <HeaderSlotProvider>
        <div
          data-testid="app-shell"
          data-boot={booting ? '' : undefined}
          className="app-zoom relative flex h-(--app-vvh,100dvh) w-full overflow-hidden bg-background"
        >
          <KeyboardShortcutsProvider />
          <TemporaryChatGuard />
          <RemotePairingConfirm />
          {/* Keeps campaign task runs going on every route (R3). */}
          {IS_TAURI && <CampaignRunHost />}
          {/* The browser's folder chooser over the server's roots. */}
          {!IS_TAURI && <ServerFolderPickerHost />}
          {/* Only a borderless window draws its own caption buttons and resize
              grips. Windows has a native title bar, which owns dragging, snap,
              double-click maximise and the caption buttons; nothing here may sit
              over the page pretending to be one (see lib/titlebar). */}
          {appDrawsChrome && <WindowControls />}
          {appDrawsChrome && <WindowResizeGrips />}
          <AppSidebar />
          <main
            data-testid="app-main"
            className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card px-3 shadow-[inset_0_0_0_0.8px_var(--border)]"
          >
            <TopHeader />
            {/* The browser client says when its server stops answering. */}
            {!IS_TAURI && <ServerOfflineBanner />}
            <div ref={pageRef} className="relative -mr-3 min-h-0 flex-1 overflow-hidden pr-3">
              <Outlet />
            </div>
          </main>
          <WebPreviewHost />
          <BrowserDomainDialog />
        </div>
      </HeaderSlotProvider>
    </ShellNavProvider>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="app-zoom relative h-svh text-sm antialiased select-text bg-background p-2">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-card text-foreground w-full overflow-hidden rounded-xl shadow-[inset_0_0_0_0.8px_var(--border)]">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

/** The main window's root: the whole app shell. */
export default function MainRootLayout() {
  const searchOpen = useSearchDialog((s) => s.open)
  const setSearchOpen = useSearchDialog((s) => s.setOpen)
  // Motion components follow Flint's Reduce motion setting, not the OS.
  const reduceMotion = useInterfaceSettings((s) => s.reduceMotion)
  const getInitialLayoutType = () => {
    const pathname = window.location.pathname
    return (
      pathname === route.localApiServerlogs ||
      pathname === route.systemMonitor ||
      pathname === route.appLogs
    )
  }

  const IS_LOGS_ROUTE = getInitialLayoutType()

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <UsageActivityRecorder />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <ActiveModelsSync />
            <GlobalEventHandler />
            <McpElicitationCard />
            {/* One mount, above every route: Search is offered from the
                rail and from Cowork's own header, and a dialog that lived
                inside the sidebar simply did not exist on a surface that did
                not render it. */}
            <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
            <CommandPalette />
            {IS_LOGS_ROUTE ? <LogsLayout /> : <AppLayout />}
          </ExtensionProvider>
          {/* <TanStackRouterDevtools position="bottom-right" /> */}
          <AttachmentIngestionDialog />
          <ErrorDialog />
          <LlamacppBusyOnExitDialog />
          <LlamacppOomListener />
          <EngineAddonOffer />
          <MissingDependenciesDialog />
          <MigrationAssistant />
          <OutOfContextPromiseModal />
          <AccessRequestDialog />
          <BypassConfirmDialog />
          <ModelReplaceDialog />
          <UnknownWindowDialog />
          <FlintServerAutoConnect />
        </TranslationProvider>
      </ServiceHubProvider>
    </MotionConfig>
  )
}
