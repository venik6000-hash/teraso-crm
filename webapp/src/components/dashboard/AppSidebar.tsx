import type { UserDto } from '@teraso-crm/contracts'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { Typography } from '@/components/typography'
import type { WorkspaceRoutePath } from '@/features/navigation'
import { DashboardLink } from './DashboardLink'
import { NavMain, type DashboardNavigationItem } from './NavMain'
import { NavUser } from './NavUser'

/**
 * User-visible chrome strings, supplied by the shell.
 *
 * The sidebar is shared by the Russian CRM and the English account console, so
 * the wording belongs to the workspace being framed, not to this component.
 */
export type ShellLabels = {
  accountItem: string
  fallbackTitle: string
  logoutFailed: string
  logoutItem: string
  logoutPending: string
  navigationGroup: string
  openAccountMenu: string
  settingsItem: string
  workspaceLabel: string
}

export function AppSidebar({
  accountPath,
  homePath,
  items,
  labels,
  onLogout,
  settingsPath,
  user,
}: {
  accountPath?: WorkspaceRoutePath
  homePath: WorkspaceRoutePath
  items: ReadonlyArray<DashboardNavigationItem>
  labels: ShellLabels
  onLogout: () => Promise<void>
  settingsPath: WorkspaceRoutePath
  user: UserDto
}) {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Teraso CRM">
              <DashboardLink to={homePath}>
                <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Typography variant="control">T</Typography>
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <Typography variant="control" truncate>
                    Teraso CRM
                  </Typography>
                  <Typography variant="caption" tone="muted" truncate>
                    {labels.workspaceLabel}
                  </Typography>
                </span>
              </DashboardLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain groupLabel={labels.navigationGroup} items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          accountPath={accountPath}
          labels={labels}
          onLogout={onLogout}
          settingsPath={settingsPath}
          user={user}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
