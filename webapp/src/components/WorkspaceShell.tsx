import {
  Analytics01Icon,
  ChartBarLineIcon,
  DashboardSquare01Icon,
  Home01Icon,
  Notification03Icon,
  Settings01Icon,
  ShieldKeyIcon,
  Task01Icon,
  UserGroupIcon,
  UserIcon,
} from '@hugeicons/core-free-icons'
import { useLocation } from '@tanstack/react-router'
import type { UserDto } from '@teraso-crm/contracts'
import type { PropsWithChildren } from 'react'

import {
  AppSidebar,
  type DashboardNavigationItem,
  type ShellLabels,
  SiteHeader,
} from '@/components/dashboard'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import {
  navigationItemsForWorkspace,
  type WorkspaceKind,
} from '@/features/navigation'
import { NotificationCenter } from '@/features/notifications'

const iconsByPath = {
  '/app': Home01Icon,
  '/app/dashboard': Analytics01Icon,
  '/app/deals': DashboardSquare01Icon,
  '/app/board': ChartBarLineIcon,
  '/app/tasks': Task01Icon,
  '/app/notifications': Notification03Icon,
  '/app/profile': UserIcon,
  '/app/settings': Settings01Icon,
  '/admin': DashboardSquare01Icon,
  '/admin/users': UserGroupIcon,
  '/admin/settings': Settings01Icon,
} as const

/**
 * The shell chrome speaks the language of the workspace it frames: the CRM is
 * the owner-facing Russian product, the account console is the template's
 * English administration area. One shell serves both, so the strings travel
 * with the workspace instead of being hard-coded inside the sidebar.
 */
const labelsByWorkspace = {
  crm: {
    accountItem: 'Профиль',
    fallbackTitle: 'Teraso CRM',
    logoutFailed: 'Не удалось выйти. Попробуйте ещё раз.',
    logoutItem: 'Выйти',
    logoutPending: 'Выходим…',
    navigationGroup: 'Разделы',
    openAccountMenu: 'Открыть меню аккаунта',
    settingsItem: 'Настройки',
    workspaceLabel: 'CRM Teraso',
  },
  admin: {
    accountItem: 'Account',
    fallbackTitle: 'Dashboard',
    logoutFailed: 'Logout failed. Please try again.',
    logoutItem: 'Log out',
    logoutPending: 'Logging out…',
    navigationGroup: 'Workspace',
    openAccountMenu: 'Open account menu',
    settingsItem: 'Settings',
    workspaceLabel: 'Admin workspace',
  },
} as const satisfies Record<WorkspaceKind, ShellLabels>

function getSidebarDefaultOpen() {
  const persistedState = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('sidebar_state='))
    ?.slice('sidebar_state='.length)

  return persistedState !== 'false'
}

export function WorkspaceShell({
  children,
  onLogout,
  user,
  workspace,
}: PropsWithChildren<{
  onLogout: () => Promise<void>
  user: UserDto
  workspace: WorkspaceKind
}>) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigationItems = navigationItemsForWorkspace(workspace, user.role)
  const activeItem = navigationItems.find((item) => item.to === pathname)
  /**
   * The bell is a shortcut into the same inbox `/app/notifications` serves, and
   * that screen is part of the administrator-only CRM product. Deriving it from the
   * navigation the model already decided keeps the role rule in one place: an
   * account with no entry for the inbox gets no bell either. Mounting it for
   * everyone made a plain account call `/api/notifications` on every page of the
   * account area and take a 403 each time.
   */
  const showsInbox = navigationItems.some((item) => item.to === '/app/notifications')
  const labels = labelsByWorkspace[workspace]
  const homePath = workspace === 'admin' ? '/admin' : '/app'
  const settingsPath = workspace === 'admin' ? '/admin/settings' : '/app/settings'
  const items: ReadonlyArray<DashboardNavigationItem> = navigationItems.map((item) => ({
    ...item,
    // The cross-workspace link is the one entry whose icon depends on where it
    // is shown rather than on where it points.
    icon: item.to === '/admin' && workspace === 'crm' ? ShieldKeyIcon : iconsByPath[item.to],
    isActive: item.to === pathname,
  }))

  return (
    <SidebarProvider defaultOpen={getSidebarDefaultOpen()}>
      <AppSidebar
        accountPath={workspace === 'crm' ? '/app/profile' : undefined}
        homePath={homePath}
        items={items}
        labels={labels}
        onLogout={onLogout}
        settingsPath={settingsPath}
        user={user}
      />
      <SidebarInset>
        {/*
          The inbox belongs to the CRM workspace as a whole, not to one screen: a
          new lead has to be visible from the profile and settings pages too. The
          account console is the template's own English surface and has no CRM
          notifications to show, and an account that cannot open the CRM has no
          notifications at all — the backend writes them for administrators only.
        */}
        <SiteHeader
          actions={workspace === 'crm' && showsInbox ? <NotificationCenter /> : undefined}
          title={activeItem?.label ?? labels.fallbackTitle}
        />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
