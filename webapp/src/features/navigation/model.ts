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
 * They name the two shells — the Russian CRM at `/app` and the template's English
 * account console at `/admin` — and nothing else. Access is a question about a
 * PATH, not about a shell, because `/app` holds two different things:
 *
 * - the CRM product (`/app/dashboard`, `/app/deals`, `/app/board`, `/app/tasks`,
 *   `/app/notifications` and the deal card), which is every screen that reads
 *   customer data. PRD 3 gives the MVP a single руководитель, so it is
 *   administrator-only and the API enforces the same rule with `requireAdmin`;
 * - the account area (`/app`, `/app/profile`, `/app/settings`), which any
 *   signed-in account needs and which the API leaves open to any session.
 *
 * `resolveRoleDestination` is where that split is decided: the guarded layouts call
 * it directly, and `safeReturnPath` asks the same question of a `returnTo` value.
 * Offering a non-administrator a link into the product would only earn them a 403
 * from the API, so the sidebar does not list one either.
 */
export type WorkspaceKind = 'crm' | 'admin'

/** The customer-data screens. Administrator-only, mirroring `requireAdmin`. */
const crmProductNavigation = [
  { label: 'Дашборд', to: '/app/dashboard' },
  { label: 'Сделки', to: '/app/deals' },
  { label: 'Воронка', to: '/app/board' },
  { label: 'Задачи', to: '/app/tasks' },
  { label: 'Уведомления', to: '/app/notifications' },
] as const satisfies ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>

/** The part of `/app` every signed-in account keeps, whatever its role. */
const crmAccountNavigation = [
  { label: 'Настройки', to: '/app/settings' },
] as const satisfies ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>

const adminNavigation = [
  { label: 'Dashboard', to: '/admin' },
  { label: 'Users', to: '/admin/users' },
  { label: 'Settings', to: '/admin/settings' },
] as const satisfies ReadonlyArray<{ label: string; to: WorkspaceRoutePath }>

/**
 * Account destinations that are reachable and linked but are not sidebar entries:
 * the workspace root, and the profile screen that lives in the account menu.
 */
const crmAccountExtraPaths = ['/app', '/app/profile'] as const satisfies ReadonlyArray<CrmRoutePath>

const UUID_PATTERN = /^[0-9a-fA-F-]{36}$/
const DEAL_PATH_PREFIX = dealPath('')

/**
 * Whether an account may mount a workspace SHELL at all — not whether it may open
 * a given screen inside it.
 *
 * `crm` is true for every role on purpose: the account area lives under `/app`, so
 * a plain account has to be able to render that shell to reach its own profile and
 * settings. The administrator-only product paths inside `/app` are refused one
 * level down, by `resolveRoleDestination`, which is the function every guard uses.
 */
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
 * An administrator gets the whole CRM plus a link into the account console, so
 * they cross between the two without typing a URL. A plain account gets only the
 * account area: the product screens would answer 403 from the API, and a link that
 * leads to a refusal is worse than no link.
 */
export function navigationItemsForWorkspace(
  workspace: WorkspaceKind,
  role: UserRole,
): ReadonlyArray<{ label: string; to: WorkspaceRoutePath }> {
  if (workspace === 'crm') {
    return canOpenCrmProduct(role)
      ? [
          ...crmProductNavigation,
          ...crmAccountNavigation,
          { label: 'Администрирование', to: '/admin' },
        ]
      : crmAccountNavigation
  }
  return [...adminNavigation, { label: 'CRM', to: '/app/deals' }]
}

/**
 * Where an account lands after signing in.
 *
 * `/app` for every role, but it means two different things there. For the owner —
 * who IS the administrator of the only account a Teraso deployment has — it is the
 * entrance to the CRM, with leads, the board and today's critical tasks one click
 * away in the sidebar. For a plain account it is simply their account home, which
 * is the whole of what they may open.
 */
export function homePathForRole(_role: UserRole): '/app' {
  return '/app'
}

/**
 * Where an account may actually go when it asks for `pathname`: the path itself
 * when the role may open it, that role's home otherwise.
 *
 * This is THE access rule the client enforces, and the guarded workspace layouts
 * call it directly, so a screen cannot be reached by a role the API would refuse.
 * The CRM product paths and the `/admin` console both ask for an administrator,
 * which is why a plain account asking for `/app/deals` or a deal card is sent back
 * to `/app` rather than shown a screen whose every request answers 403.
 *
 * The return type is a plain string because a deal card — `/app/deals/{uuid}` — is
 * a legitimate destination without being one of the named route paths.
 */
export function resolveRoleDestination(role: UserRole, pathname: string): string {
  return isPermittedPath(role, pathname) ? pathname : homePathForRole(role)
}

/**
 * Where a signed-in account may be returned to after logging in.
 *
 * It answers the same permission question as `resolveRoleDestination` — one rule,
 * so a path that is refused by the guard cannot be smuggled back in through
 * `returnTo` — and adds the URL hardening: the value arrives from the query
 * string, so anything absolute, protocol-relative or unparseable is rejected
 * before the permission check is even asked.
 *
 * The deal card is included because a notification links straight at it: without
 * it, an administrator following a push while signed out would land on the
 * workspace root instead of the deal the alert was about. The destination is
 * rebuilt from the contract's own `dealPath` so this file cannot become a second
 * spelling of it, and the identifier is shape-checked so the rule can never widen
 * into an open redirect.
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

  return isPermittedPath(role, url.pathname) ? `${url.pathname}${url.search}` : null
}

function isPermittedPath(role: UserRole, pathname: string) {
  return isKnownWorkspacePath(role, pathname) || (isDealPath(pathname) && canOpenCrmProduct(role))
}

/**
 * The CRM product — every screen that reads customer data — belongs to the
 * руководитель (PRD 3), and `requireAdmin` enforces the same rule on the API.
 * Stated once here so the sidebar, the deal card and the guard cannot drift.
 */
function canOpenCrmProduct(role: UserRole) {
  return role === 'admin'
}

function isDealPath(pathname: string) {
  return (
    pathname.startsWith(DEAL_PATH_PREFIX) &&
    UUID_PATTERN.test(pathname.slice(DEAL_PATH_PREFIX.length))
  )
}

/**
 * A named destination this role may open. The role is what narrows it: the CRM
 * sidebar of a plain account holds only the account area, so every product path
 * fails this check without the rule being restated here.
 */
function isKnownWorkspacePath(role: UserRole, pathname: string) {
  const workspace = workspaceForPath(pathname)
  if (!canOpenWorkspace(workspace, role)) return false

  return (
    navigationItemsForWorkspace(workspace, role).some((item) => item.to === pathname) ||
    (workspace === 'crm' && crmAccountExtraPaths.some((path) => path === pathname))
  )
}
