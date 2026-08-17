import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dealPath } from '@teraso-crm/contracts'

import { clearPasswordResetTokenHash } from '../src/features/auth/password-reset-location'
import { resolveRoleDestination } from '../src/features/navigation/model'

test('password reset token cleanup preserves router-managed history state', () => {
  const routerState = { __TSR_index: 4, key: 'reset-entry' }
  const replacements: Array<{ state: unknown; title: string; url?: string | URL | null }> = []

  clearPasswordResetTokenHash(
    {
      hash: '#token=secret',
      pathname: '/reset-password',
      search: '?campaign=welcome',
    },
    {
      state: routerState,
      replaceState: (state, title, url) => {
        replacements.push({ state, title, url })
      },
    },
  )

  expect(replacements).toEqual([
    {
      state: routerState,
      title: '',
      url: '/reset-password?campaign=welcome',
    },
  ])
})

/* ------------------------------------------------------------------ *
 * The router and the access rule (PRD 3, PRD 10)
 * ------------------------------------------------------------------ */

const DEAL_ID = '11111111-1111-4111-8111-111111111111'

/**
 * Every workspace route the router serves, read out of `routes.tsx` itself so a
 * screen added there cannot escape the two cases below. The deal card is spelled
 * through the contract's `dealPath` because the router registers it as a parameter
 * (`$dealId`) rather than a literal.
 */
const routerWorkspacePaths = [
  ...readFileSync(new URL('../src/routes.tsx', import.meta.url), 'utf8')
    .matchAll(/path:\s*'(\/(?:app|admin)[^']*)'/g)
    .map((match) => match[1]!),
  dealPath(DEAL_ID),
]

const ACCOUNT_PATHS = ['/app', '/app/profile', '/app/settings']

/**
 * The guarded layouts refuse anything `resolveRoleDestination` does not hand back
 * unchanged, so a route the navigation model has never heard of is refused to
 * EVERYONE — including the administrator it was built for. That failure mode is
 * silent in the router and invisible in a screenshot, which is what this pins.
 */
test('the access model knows every workspace route the router serves', () => {
  expect(routerWorkspacePaths.length).toBeGreaterThan(10)
  for (const path of routerWorkspacePaths) {
    expect(`${path} -> ${resolveRoleDestination('admin', path)}`).toBe(`${path} -> ${path}`)
  }
})

/**
 * The other half: a plain account may open its account area and nothing else.
 * Registration is open and creates that role, so this list is the whole of what a
 * self-registered account can reach — the CRM product screens and the account
 * console are refused, exactly as the API refuses their data with 403.
 */
test('a plain account may open the account area and nothing else the router serves', () => {
  const permitted = routerWorkspacePaths.filter(
    (path) => resolveRoleDestination('user', path) === path,
  )

  expect(permitted.sort()).toEqual([...ACCOUNT_PATHS].sort())
})
