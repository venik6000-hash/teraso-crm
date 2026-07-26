import { APP_PATH_PREFIX, dealPath, type UserRole } from '@teraso-crm/contracts'

export type CrmRoutePath =
  | '/app'
  | '/app/dashboard'
  | '/app/deals'
  | '/app/board'
  | '/app/tasks'
  | '/app/notifications'
  | '/app/profile'
  | '/app/settings'
export type AdminRoutePath = '/admin' | '/admin/users' | '/admin/settings'
export type WorkspaceRoutePath = CrmRoutePath | AdminRoutePath

/**
 * The two workspaces, which are deliberately not the two roles.
 *
 * `/app` is the product: PRD 3 gives the MVP a single руководитель with full
 * access, Task 6 writes notifications for every account regardless of role, and
 * the deal card is the destination stored in those notifications — so the CRM
 * requires authentication, not a particular role. `/admin` is the template's
 * account console and stays administrator-only.
 *
 * Reading access from the workspace rather than from the role is what keeps the
 * seeded administrator — the only account a fresh deployment has — from being
 * bounced out of the product it exists to run.
 */
export type WorkspaceKind = 'crm' | 'admin'

const crmNavigation = [
  { label: 'Дашборд', to: '/app/dashboard' },
  { label: 'Сделки', to: '/app/deals' },
  { label: 'Воронка', to: '/app/board' },
  { label: 'Задачи', to: '/app/tasks' },
  { label: 'Уведомления', to: '/app/notifications' },
  { label: 'Настройки', to: '/app/settings' },
] as const satisfies ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>

const adminNavigation = [
  { label: 'Dashboard', to: '/admin' },
  { label: 'Users', to: '/admin/users' },
  { label: 'Settings', to: '/admin/settings' },
] as const satisfies ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>

/** Reachable destinations that are not sidebar entries but are still linked. */
const crmExtraPaths = ['/app', '/app/profile'] as const satisfies ReadonlyArray<CrmRoutePath>

const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/
const DEAL_PATH_PREFIX = dealPath('')

export function canOpenWorkspace(workspace: WorkspaceKind, role: UserRole) {
  return workspace === 'crm' || role === 'admin'
}

export function workspaceForPath(pathname: string): WorkspaceKind {
  return pathname === APP_PATH_PREFIX || pathname.startsWith(`${APP_PATH_PREFIX}/`)
    ? 'crm'
    : 'admin'
}

/**
 * The sidebar for a workspace.
 *
 * Each workspace links to the other one the account may open, so an
 * administrator crosses between the CRM and the account console without having
 * to type a URL.
 */
export function navigationItemsForWorkspace(
  workspace: WorkspaceKind,
  role: UserRole,
): ReadonlyArray<{ label: string; to: WorkspaceRoutePath }> {
  if (workspace === 'crm') {
    return role === 'admin'
      ? [...crmNavigation, { label: 'Администрирование', to: '/admin' }]
      : crmNavigation
  }
  return [...adminNavigation, { label: 'CRM', to: '/app/deals' }]
}

export function homePathForRole(role: UserRole): '/app' | '/admin' {
  return role === 'admin' ? '/admin' : '/app'
}

export function resolveRoleDestination(
  role: UserRole,
  pathname: string,
): WorkspaceRoutePath {
  return isKnownWorkspacePath(role, pathname)
    ? (pathname as WorkspaceRoutePath)
    : homePathForRole(role)
}

/**
 * Where a signed-in account may be returned to after logging in.
 *
 * The deal card is included because a notification links straight at it:
 * without it, following a push while signed out would drop the owner on the
 * workspace root instead of the deal the alert was about. The destination is
 * rebuilt from the contract's own `dealPath` so this file cannot become a
 * second spelling of it, and the identifier is shape-checked so the rule can
 * never widen into an open redirect.
 */
export function safeReturnPath(role: UserRole, value: string | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null

  let url: URL
  try {
    url = new URL(value, 'https://app.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://app.invalid') return null

  const isKnown = isKnownWorkspacePath(role, url.pathname) || isDealPath(url.pathname)
  return isKnown ? `${url.pathname}${url.search}` : null
}

function isDealPath(pathname: string) {
  return (
    pathname.startsWith(DEAL_PATH_PREFIX) &&
    UUID_PATTERN.test(pathname.slice(DEAL_PATH_PREFIX.length))
  )
}

function isKnownWorkspacePath(role: UserRole, pathname: string) {
  const workspace = workspaceForPath(pathname)
  if (!canOpenWorkspace(workspace, role)) return false

  return (
    navigationItemsForWorkspace(workspace, role).some((item) => item.to === pathname) ||
    (workspace === 'crm' && crmExtraPaths.some((path) => path === pathname))
  )
}
