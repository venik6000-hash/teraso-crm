import { spawnSync } from 'node:child_process'

import type { Page } from '@playwright/test'

import { composeEnv, repositoryRoot } from '../env'

export { expect, test } from '@playwright/test'

export const e2ePassword = 'password123'

/**
 * Creates an account the way the product does: against the deployment.
 *
 * There is no registration page to drive, because Teraso CRM serves one company
 * and nobody signs themselves up. Specs that need an account therefore run the
 * same operator command an administrator would, then sign in through the real
 * login form — so what these tests exercise is the flow that actually exists.
 */
export function createAccount(
  email: string,
  {
    displayName,
    password = e2ePassword,
    role = 'user',
  }: { displayName?: string; password?: string; role?: 'admin' | 'user' } = {},
) {
  const result = spawnSync(
    'bun',
    [
      'run',
      '--cwd',
      'backend',
      'create:account',
      '--',
      `--email=${email}`,
      `--role=${role}`,
      ...(displayName ? [`--display-name=${displayName}`] : []),
    ],
    {
      cwd: repositoryRoot,
      // The password travels in the environment, not in argv, so it stays out of
      // the process list on a shared machine.
      env: composeEnv({ ACCOUNT_PASSWORD: password }),
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    throw new Error(`Could not create ${email}: ${result.stderr || result.stdout}`)
  }
}

/**
 * Signs in through the login form, typing key by key.
 *
 * TanStack Form remounts the field while the router settles, so a bare `fill`
 * can land on an element that is about to be replaced and leave the controlled
 * input empty. Typing and then asserting the value is the stable way in.
 */
export async function signInHere(page: Page, email: string, password = e2ePassword) {
  const { expect } = await import('@playwright/test')

  await expect(async () => {
    await page.getByLabel('Email').click()
    await page.getByLabel('Email').pressSequentially(email)
    await page.getByLabel('Password', { exact: true }).click()
    await page.getByLabel('Password', { exact: true }).pressSequentially(password)
    await expect(page.getByLabel('Email')).toHaveValue(email)
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(password)
  }).toPass({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Login' }).click()
}

/** Opens the login page first. Use `signInHere` when a redirect already landed there. */
export async function signIn(page: Page, email: string, password = e2ePassword) {
  await page.goto('/login')
  await signInHere(page, email, password)
}

/** Creates an account and signs into it: the usual opening of a spec. */
export async function createAccountAndSignIn(
  page: Page,
  email: string,
  options: { displayName?: string; password?: string; role?: 'admin' | 'user' } = {},
) {
  createAccount(email, options)
  await signIn(page, email, options.password ?? e2ePassword)
}

export function uniqueEmail(prefix = 'web-e2e') {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '')
  const suffix = Math.random().toString(36).slice(2, 8)

  return `${prefix}-${timestamp}-${suffix}@example.com`
}
