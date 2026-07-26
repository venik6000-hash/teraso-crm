import type { UserRole } from '@teraso-crm/contracts'

export type UserRoutePath =
  | '/app'
  | '/app/dashboard'
  | '/app/deals'
  | '/app/board'
  | '/app/tasks'
  | '/app/notifications'
  | '/app/profile'
  | '/app/settings'
export type AdminRoutePath = '/admin' | '/admin/users' | '/admin/settings'
export type WorkspaceRoutePath = UserRoutePath | AdminRoutePath

/**
 * The workspace sidebar.
 *
 * The user workspace *is* the CRM (PRD 7.0: navigation on the left on desktop,
 * in a sheet on a phone), so it lists the CRM sections rather than the template's
 * demo pages. Profile stays reachable from the account menu, and the workspace
 * root `/app` from the sidebar header, so nothing became unreachable.
 *
 * The admin workspace is the platform console — accounts and roles — and is
 * deliberately unchanged and still English.
 */
const navigationByRole = {
  user: [
    { label: 'Дашборд', to: '/app/dashboard' },
    { label: 'Сделки', to: '/app/deals' },
    { label: 'Воронка', to: '/app/board' },
    { label: 'Задачи', to: '/app/tasks' },
    { label: 'Уведомления', to: '/app/notifications' },
    { label: 'Настройки', to: '/app/settings' },
  ],
  admin: [
    { label: 'Dashboard', to: '/admin' },
    { label: 'Users', to: '/admin/users' },
    { label: 'Settings', to: '/admin/settings' },
  ],
} as const satisfies Record<UserRole, ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>>

/**
 * Reachable destinations that are not sidebar entries: the workspace root and
 * the account page, both still linked from the shell.
 */
const extraPathsByRole = {
  user: ['/app', '/app/profile'],
  admin: [],
} as const satisfies Record<UserRole, ReadonlyArray<WorkspaceRoutePath>>

/**
 * Dynamic destinations a signed-in user may be returned to after logging in.
 *
 * The deal card is here because a notification links straight at it: without
 * this, following a push while signed out would drop the owner on the workspace
 * root instead of the deal the alert was about. The pattern stays anchored and
 * shape-checked so it can never widen into an open redirect.
 */
const returnablePathPatterns: Record<UserRole, ReadonlyArray<RegExp>> = {
  user: [/^\/app\/deals\/[0-9a-fA-F-]{36}$/],
  admin: [],
}

function isKnownWorkspacePath(role: UserRole, pathname: string) {
  return (
    navigationItemsForRole(role).some((item) => item.to === pathname) ||
    extraPathsByRole[role].some((path) => path === pathname)
  )
}

export function navigationItemsForRole(role: UserRole) {
  return navigationByRole[role]
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

export function safeReturnPath(role: UserRole, value: string | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null

  let url: URL
  try {
    url = new URL(value, 'https://app.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://app.invalid') return null

  const isKnown =
    isKnownWorkspacePath(role, url.pathname) ||
    returnablePathPatterns[role].some((pattern) => pattern.test(url.pathname))
  return isKnown ? `${url.pathname}${url.search}` : null
}
