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

test('the CRM is the product and needs a session, not a particular role', () => {
  // The seeded account is an administrator, so gating `/app` on `role === user`
  // locked the only account a fresh deployment has out of the product.
  expect(canOpenWorkspace('crm', 'admin')).toBe(true)
  expect(canOpenWorkspace('crm', 'user')).toBe(true)
  expect(canOpenWorkspace('admin', 'admin')).toBe(true)
  expect(canOpenWorkspace('admin', 'user')).toBe(false)
  expect(workspaceForPath('/app/deals')).toBe('crm')
  expect(workspaceForPath(dealPath(DEAL_ID))).toBe('crm')
  expect(workspaceForPath('/admin/users')).toBe('admin')
})

test('each workspace lists its own sections and the other one it may open', () => {
  expect(navigationItemsForWorkspace('crm', 'user')).toEqual([
    { label: 'Дашборд', to: '/app/dashboard' },
    { label: 'Сделки', to: '/app/deals' },
    { label: 'Воронка', to: '/app/board' },
    { label: 'Задачи', to: '/app/tasks' },
    { label: 'Уведомления', to: '/app/notifications' },
    { label: 'Настройки', to: '/app/settings' },
  ])
  expect(navigationItemsForWorkspace('crm', 'admin').at(-1)).toEqual({
    label: 'Администрирование',
    to: '/admin',
  })
  expect(navigationItemsForWorkspace('admin', 'admin')).toEqual([
    { label: 'Dashboard', to: '/admin' },
    { label: 'Users', to: '/admin/users' },
    { label: 'Settings', to: '/admin/settings' },
    { label: 'CRM', to: '/app/deals' },
  ])
  expect(homePathForRole('user')).toBe('/app')
  expect(homePathForRole('admin')).toBe('/admin')
})

test('destinations outside an account reach resolve to its home', () => {
  expect(resolveRoleDestination('user', '/app/profile')).toBe('/app/profile')
  expect(resolveRoleDestination('user', '/app/deals')).toBe('/app/deals')
  expect(resolveRoleDestination('user', '/admin/users')).toBe('/app')
  expect(resolveRoleDestination('admin', '/admin/settings')).toBe('/admin/settings')
  expect(resolveRoleDestination('admin', '/app/deals')).toBe('/app/deals')
})

test('return paths accept only known internal destinations for the account', () => {
  expect(safeReturnPath('user', '/app/profile')).toBe('/app/profile')
  expect(safeReturnPath('user', '/app/deals?stage=NEW')).toBe('/app/deals?stage=NEW')
  expect(safeReturnPath('admin', '/admin/users?page=2')).toBe('/admin/users?page=2')
  expect(safeReturnPath('user', '/admin')).toBeNull()
  expect(safeReturnPath('admin', 'https://attacker.example/admin')).toBeNull()
  expect(safeReturnPath('admin', '//attacker.example/admin')).toBeNull()
  expect(safeReturnPath('user', '/app/unknown')).toBeNull()
})

test('a notification deep link survives the sign-in round trip for either role', () => {
  expect(safeReturnPath('user', dealPath(DEAL_ID))).toBe(dealPath(DEAL_ID))
  // Notifications are written for every account, so an administrator following
  // one must land on the deal rather than on the account console.
  expect(safeReturnPath('admin', dealPath(DEAL_ID))).toBe(dealPath(DEAL_ID))
  expect(safeReturnPath('user', '/app/deals/not-a-uuid')).toBeNull()
  expect(safeReturnPath('user', `${dealPath(DEAL_ID)}/extra`)).toBeNull()
})
