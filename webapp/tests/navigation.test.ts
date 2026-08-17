import { expect, test } from 'bun:test'
import { dealPath } from '@teraso-crm/contracts'

import {
  canOpenWorkspace,
  homePathForRole,
  navigationItemsForWorkspace,
  resolveRoleDestination,
  safeReturnPath,
  workspaceForPath,
} from '../src/features/navigation/model'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'

const CRM_PRODUCT_PATHS = [
  '/app/dashboard',
  '/app/deals',
  '/app/board',
  '/app/tasks',
  '/app/notifications',
  dealPath(DEAL_ID),
] as const

const CRM_ACCOUNT_PATHS = ['/app', '/app/profile', '/app/settings'] as const

/**
 * `canOpenWorkspace` answers about a SHELL, not a screen. Both `/app` answers are
 * true because the account area lives in that shell; the administrator-only half
 * of `/app` is refused one level down, by `resolveRoleDestination`.
 */
test('the workspace question is about the shell, not about the screens inside it', () => {
  expect(canOpenWorkspace('crm', 'admin')).toBe(true)
  expect(canOpenWorkspace('crm', 'user')).toBe(true)
  expect(canOpenWorkspace('admin', 'admin')).toBe(true)
  expect(canOpenWorkspace('admin', 'user')).toBe(false)
  expect(workspaceForPath('/app/deals')).toBe('crm')
  expect(workspaceForPath(dealPath(DEAL_ID))).toBe('crm')
  expect(workspaceForPath('/admin/users')).toBe('admin')
})

/**
 * The regression guard for the access rule on the client (PRD 3, PRD 10).
 *
 * Registration is open and hands out the `user` role, and the CRM API answers 403
 * to that role. A sidebar that offered those screens anyway would be advertising
 * refusals, and the guard that let the account walk into them was the interface
 * half of the same defect.
 */
test('a plain account keeps the account area and is refused the CRM product', () => {
  for (const path of CRM_ACCOUNT_PATHS) {
    expect(`${path} -> ${resolveRoleDestination('user', path)}`).toBe(`${path} -> ${path}`)
  }
  for (const path of CRM_PRODUCT_PATHS) {
    expect(`${path} -> ${resolveRoleDestination('user', path)}`).toBe(`${path} -> /app`)
    expect(safeReturnPath('user', path)).toBeNull()
  }
})

test('an administrator opens the CRM product, the account area and the console', () => {
  for (const path of [...CRM_PRODUCT_PATHS, ...CRM_ACCOUNT_PATHS, '/admin', '/admin/users']) {
    expect(`${path} -> ${resolveRoleDestination('admin', path)}`).toBe(`${path} -> ${path}`)
  }
})

test('each workspace lists its own sections and the other one it may open', () => {
  expect(navigationItemsForWorkspace('crm', 'admin')).toEqual([
    { label: 'Дашборд', to: '/app/dashboard' },
    { label: 'Сделки', to: '/app/deals' },
    { label: 'Воронка', to: '/app/board' },
    { label: 'Задачи', to: '/app/tasks' },
    { label: 'Уведомления', to: '/app/notifications' },
    { label: 'Настройки', to: '/app/settings' },
    { label: 'Администрирование', to: '/admin' },
  ])
  // No links into the product: every one of them would earn a 403.
  expect(navigationItemsForWorkspace('crm', 'user')).toEqual([
    { label: 'Настройки', to: '/app/settings' },
  ])
  expect(navigationItemsForWorkspace('admin', 'admin')).toEqual([
    { label: 'Dashboard', to: '/admin' },
    { label: 'Users', to: '/admin/users' },
    { label: 'Settings', to: '/admin/settings' },
    { label: 'CRM', to: '/app/deals' },
  ])
})

/**
 * Both roles land on `/app`, where it means two different things: the entrance to
 * the CRM for the owner — who IS the administrator of the only account a Teraso
 * deployment has — and simply the account home for anybody else.
 */
test('signing in lands every role on the workspace root', () => {
  expect(homePathForRole('user')).toBe('/app')
  expect(homePathForRole('admin')).toBe('/app')
})

test('destinations outside an account reach resolve to its home', () => {
  expect(resolveRoleDestination('user', '/app/profile')).toBe('/app/profile')
  expect(resolveRoleDestination('user', '/admin/users')).toBe('/app')
  expect(resolveRoleDestination('user', '/app/unknown')).toBe('/app')
  expect(resolveRoleDestination('admin', '/admin/settings')).toBe('/admin/settings')
  expect(resolveRoleDestination('admin', '/app/unknown')).toBe('/app')
})

test('return paths accept only known internal destinations for the account', () => {
  expect(safeReturnPath('user', '/app/profile')).toBe('/app/profile')
  expect(safeReturnPath('user', '/app/settings')).toBe('/app/settings')
  expect(safeReturnPath('admin', '/app/deals?stage=NEW')).toBe('/app/deals?stage=NEW')
  expect(safeReturnPath('admin', '/admin/users?page=2')).toBe('/admin/users?page=2')
  expect(safeReturnPath('user', '/admin')).toBeNull()
  expect(safeReturnPath('admin', 'https://attacker.example/admin')).toBeNull()
  expect(safeReturnPath('admin', '//attacker.example/admin')).toBeNull()
  expect(safeReturnPath('user', '/app/unknown')).toBeNull()
})

/**
 * A notification links straight at a deal card, and notifications are written for
 * administrators only — so the round trip has to survive for that role and must
 * not smuggle a plain account into a deal it cannot open.
 */
test('a notification deep link survives the sign-in round trip for an administrator', () => {
  expect(safeReturnPath('admin', dealPath(DEAL_ID))).toBe(dealPath(DEAL_ID))
  expect(resolveRoleDestination('admin', dealPath(DEAL_ID))).toBe(dealPath(DEAL_ID))
  expect(safeReturnPath('user', dealPath(DEAL_ID))).toBeNull()
  expect(resolveRoleDestination('user', dealPath(DEAL_ID))).toBe('/app')
  expect(safeReturnPath('admin', '/app/deals/not-a-uuid')).toBeNull()
  expect(safeReturnPath('admin', `${dealPath(DEAL_ID)}/extra`)).toBeNull()
})
