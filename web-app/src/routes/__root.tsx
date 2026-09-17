import { createRootRoute, Outlet } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { Fragment } from 'react/jsx-runtime'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { CommandPalette } from '@/containers/CommandPalette'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useClearSettingsSearchOnExit } from '@/hooks/useSettingsSearch'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { WebPreviewHost } from '@/containers/WebPreviewHost'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LeftSidebar } from '@/components/left-sidebar'
import { AppRail } from '@/components/shell/AppRail'
import { StatusBar } from '@/components/shell/StatusBar'
import { WindowControls } from '@/components/WindowControls'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { MigrationAssistant } from '@/containers/MigrationAssistant'
import { TemporaryChatGuard } from '@/containers/TemporaryChatGuard'
import { useWindowTitle } from '@/hooks/useWindowTitle'
import { useAppViewport } from '@/hooks/useAppViewport'
import { detectWindowChrome } from '@/lib/titlebar'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})

/**
 * The Flint Atelier shell: graphite rail | contextual sidebar | page, with the
 * status bar across the bottom. One shell for every route; pages supply their
 * own context bar (HeaderPage) and content. On phones the rail and sidebar
 * move into one navigation sheet opened from the context bar.
 */
const AppLayout = () => {
  // The settings-search query outlives each settings page on purpose; it must
  // not outlive the section. Mounted here because this layout stays put.
  useClearSettingsSearchOnExit()
  useWindowTitle()
  useAppViewport()
  const appDrawsChrome = detectWindowChrome() === 'custom'
  const {
    open: isLeftPanelOpen,
    setLeftPanel,
    width: sidebarWidth,
    setLeftPanelWidth,
  } = useLeftPanel()

  return (
    <div
      data-testid="app-shell"
      className="relative flex h-(--app-vvh,100dvh) w-full flex-col overflow-hidden bg-background"
    >
      <SidebarProvider
        open={isLeftPanelOpen}
        onOpenChange={setLeftPanel}
        defaultWidth={sidebarWidth}
        onWidthChange={setLeftPanelWidth}
        className="min-h-0 flex-1"
      >
        <KeyboardShortcutsProvider />
        <TemporaryChatGuard />
        {/* Only a borderless window draws its own caption buttons and resize
            grips. Windows has a native title bar, which owns dragging, snap,
            double-click maximise and the caption buttons; nothing here may sit
            over the page pretending to be one (see lib/titlebar). */}
        {appDrawsChrome && <WindowControls />}
        {appDrawsChrome && <WindowResizeGrips />}
        <AppRail className="hidden lg:flex" />
        <LeftSidebar />
        <SidebarInset>
          <div className="size-full min-h-0 bg-background">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <StatusBar />
      <WebPreviewHost />
    </div>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="relative h-svh text-sm antialiased select-text bg-background">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-background text-foreground border w-full overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

function RootLayout() {
  const searchOpen = useSearchDialog((s) => s.open)
  const setSearchOpen = useSearchDialog((s) => s.setOpen)
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
    <Fragment>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <GlobalEventHandler />
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
          <MissingDependenciesDialog />
          <MigrationAssistant />
          <OutOfContextPromiseModal />
        </TranslationProvider>
      </ServiceHubProvider>
    </Fragment>
  )
}
