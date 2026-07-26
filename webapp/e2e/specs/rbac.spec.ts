import type { Page } from '@playwright/test'
import { e2eAdminEmail, e2eAdminPassword } from '../env'
import { e2ePassword, expect, test, uniqueEmail } from '../helpers/test'

test('keeps user and administrator workspaces separate', async ({ browser, page }) => {
  const userEmail = uniqueEmail('web-e2e-rbac-user')

  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fusers$/)
  await page.getByRole('link', { name: 'Sign up' }).click()

  await fillSignupCredentials(page, userEmail)
  await page.getByRole('button', { name: 'Create Account' }).click()

  await expect(page).toHaveURL(/\/app$/)
  await expect(page.getByRole('link', { name: 'Сделки' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0)
  const sidebar = page.locator('[data-slot="sidebar"][data-state]')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await page.locator('[data-sidebar="trigger"]').click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.getByRole('link', { name: 'Сделки' }).click()
  await expect(page).toHaveURL(/\/app\/deals$/)
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.reload()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/app$/)

  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/login')
  await signIn(adminPage, e2eAdminEmail, e2eAdminPassword)

  // Signing in lands the administrator in the CRM: they are the owner, and the
  // product they open the app for is the CRM rather than user management. The
  // account console stays one click away in the sidebar.
  await expect(adminPage).toHaveURL(/\/app$/)
  await openAdminWorkspace(adminPage)
  await expect(adminPage.getByRole('main')).toHaveCount(1)
  await expect(adminPage.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(adminPage.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Users' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Settings' })).toBeVisible()
  await expect(adminPage.getByRole('link', { name: 'Home' })).toHaveCount(0)
  // The CRM is the product and asks only for a session: the seeded
  // administrator must be able to open it, because it is the only account a
  // fresh deployment has and every notification links into it.
  await adminPage.getByRole('link', { name: 'CRM', exact: true }).click()
  await expect(adminPage).toHaveURL(/\/app\/deals$/)
  await expect(adminPage.getByRole('heading', { level: 1, name: 'Сделки' })).toBeVisible()
  await adminPage.goto('/app/profile')
  await expect(adminPage).toHaveURL(/\/app\/profile$/)
  await openAdminWorkspace(adminPage)

  await adminContext.close()
})

test('mobile workspace navigation closes the sidebar sheet', async ({ page }) => {
  const userEmail = uniqueEmail('web-e2e-mobile-sidebar')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/signup')
  await fillSignupCredentials(page, userEmail)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await page.locator('[data-sidebar="trigger"]').click()
  const mobileSidebar = page.locator('[data-slot="sidebar"][data-mobile="true"]')
  await expect(mobileSidebar).toBeVisible()
  await page.getByRole('link', { name: 'Сделки' }).click()

  await expect(page).toHaveURL(/\/app\/deals$/)
  await expect(mobileSidebar).toBeHidden()
})

test('workspace navigation and account controls are keyboard operable', async ({
  page,
}) => {
  await page.goto('/login')
  await signIn(page, e2eAdminEmail, e2eAdminPassword)
  // The administrator lands in the CRM and crosses into the account console.
  await expect(page).toHaveURL(/\/app$/)
  await openAdminWorkspace(page)

  const usersLink = page.getByRole('link', { name: 'Users' })
  await usersLink.focus()
  await expect(usersLink).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/users$/)

  const accountMenu = page.getByRole('button', { name: 'Open account menu' })
  await accountMenu.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeHidden()
  await expect(accountMenu).toBeFocused()

  const sidebar = page.locator('[data-slot="sidebar"][data-state]')
  const sidebarTrigger = page.locator('[data-sidebar="trigger"]')
  await sidebarTrigger.focus()
  await page.keyboard.press('Enter')
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
})

test('admin data surfaces recover from errors and expose safe directory states', async ({
  page,
}) => {
  let dashboardRequests = 0
  await page.route('**/api/admin/dashboard', async (route) => {
    dashboardRequests += 1
    if (dashboardRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Dashboard temporarily unavailable' },
        }),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/login')
  await signIn(page, e2eAdminEmail, e2eAdminPassword)

  await expect(page).toHaveURL(/\/app$/)
  await openAdminWorkspace(page)
  await expect(page.getByRole('alert')).toContainText('Dashboard temporarily unavailable')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Total users', { exact: true })).toBeVisible()
  await expect(page.getByText('Administrators', { exact: true })).toBeVisible()
  await expect(page.getByText('New in 7 days', { exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="chart"]')).toHaveCount(0)

  let directoryRequests = 0
  await page.route('**/api/admin/users?*', async (route) => {
    directoryRequests += 1
    if (directoryRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: 'Directory temporarily unavailable' },
        }),
      })
      return
    }
    await route.continue()
  })
  await page.getByRole('link', { name: 'Users' }).click()
  await expect(page.getByRole('alert')).toContainText('Directory temporarily unavailable')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText(/Page 1 of \d+ · \d+ users/)).toBeVisible()

  await page.getByLabel('Search users').fill(e2eAdminEmail)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByLabel(`Role for ${e2eAdminEmail}`).click()
  await expect(page.getByRole('option', { name: 'User' })).toBeDisabled()
  await page.keyboard.press('Escape')

  await page.getByLabel('Search users').fill(`missing-${Date.now()}@example.com`)
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByText('No users found', { exact: true })).toBeVisible()
  await expect(page.getByText('Try a different name or email.')).toBeVisible()
})

test('workspace account menu keeps a failed logout visible and retryable', async ({ page }) => {
  const userEmail = uniqueEmail('web-e2e-sidebar-logout')
  await page.goto('/signup')
  await fillSignupCredentials(page, userEmail)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page).toHaveURL(/\/app$/)

  await page.route('**/api/auth/logout', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'UNAVAILABLE', message: 'Temporary logout failure' },
      }),
    })
  })

  const sidebar = page.locator('[data-slot="sidebar"][data-state]')
  await page.locator('[data-sidebar="trigger"]').click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.locator('[data-sidebar="footer"] [data-sidebar="menu-button"]').click()
  await page.getByRole('menuitem', { name: 'Выйти' }).click()

  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expect(page.getByRole('alert')).toHaveText('Не удалось выйти. Попробуйте ещё раз.')
  await expect(page).toHaveURL(/\/app$/)
  await page.locator('[data-sidebar="footer"] [data-sidebar="menu-button"]').click()
  await expect(page.getByRole('menuitem', { name: 'Выйти' })).toBeEnabled()
})

test('role mutation failures are announced inside the confirmation dialog', async ({
  browser,
  page,
}) => {
  const userEmail = uniqueEmail('web-e2e-role-error')
  await page.goto('/signup')
  await fillSignupCredentials(page, userEmail)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page).toHaveURL(/\/app$/)

  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/login')
  await signIn(adminPage, e2eAdminEmail, e2eAdminPassword)
  await openAdminWorkspace(adminPage)
  await adminPage.getByRole('link', { name: 'Users' }).click()
  await adminPage.getByLabel('Search users').fill(userEmail)
  await adminPage.getByRole('button', { name: 'Search' }).click()
  await adminPage.route('**/api/admin/users/*/role', async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'CONFLICT',
          message: 'The requested role change conflicts with administrator policy',
        },
      }),
    })
  })

  await adminPage.getByLabel(`Role for ${userEmail}`).click()
  await adminPage.getByRole('option', { name: 'Admin' }).click()
  const dialog = adminPage.getByRole('alertdialog')
  await adminPage.getByRole('button', { name: 'Change role' }).click()

  await expect(dialog).toContainText('Role was not changed')
  await expect(dialog).toContainText('administrator policy')
  await adminContext.close()
})

test('promoting a user revokes the old session and opens the admin workspace after login', async ({
  browser,
  page,
}) => {
  const userEmail = uniqueEmail('web-e2e-promoted-user')

  await page.goto('/signup')
  await fillSignupCredentials(page, userEmail)
  await page.getByRole('button', { name: 'Create Account' }).click()
  await expect(page).toHaveURL(/\/app$/)

  const adminContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  await adminPage.goto('/login')
  await signIn(adminPage, e2eAdminEmail, e2eAdminPassword)
  await openAdminWorkspace(adminPage)
  await adminPage.getByRole('link', { name: 'Users' }).click()

  await adminPage.getByLabel('Search users').fill(userEmail)
  await adminPage.getByRole('button', { name: 'Search' }).click()
  const roleSelect = adminPage.getByLabel(`Role for ${userEmail}`)
  await expect(roleSelect).toBeVisible()
  await roleSelect.click()
  await adminPage.getByRole('option', { name: 'Admin' }).click()
  await expect(adminPage.getByRole('alertdialog')).toContainText(userEmail)
  await adminPage.getByRole('button', { name: 'Change role' }).click()
  await expect(adminPage.getByText('Role changed')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: 'Login' })).toBeVisible()
  await signIn(page, userEmail, e2ePassword)

  // A freshly promoted administrator lands in the CRM like any other account,
  // and the account console is now reachable from its sidebar.
  await expect(page).toHaveURL(/\/app$/)
  await openAdminWorkspace(page)
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0)

  await adminContext.close()
})


/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Types the signup credentials and confirms they stuck.
 *
 * The guest pages swap their whole subtree as the session bootstrap settles
 * (loading -> form), so a programmatic `fill` that lands mid-swap sets a value
 * on an element that is about to be replaced, and the controlled input comes
 * back empty. Typing key by key and asserting the result is the stable way in;
 * the bare `fill` only looked reliable while a cold dev server kept the page
 * slow enough to hide the race.
 */
async function fillSignupCredentials(page: Page, email: string) {
  await expect(async () => {
    await page.getByLabel('Email').click()
    await page.getByLabel('Email').pressSequentially(email)
    await page.getByLabel('Password', { exact: true }).click()
    await page.getByLabel('Password', { exact: true }).pressSequentially(e2ePassword)
    await page.getByLabel('Confirm Password').click()
    await page.getByLabel('Confirm Password').pressSequentially(e2ePassword)
    await expect(page.getByLabel('Email')).toHaveValue(email)
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(e2ePassword)
  }).toPass({ timeout: 15_000 })
}

/**
 * Signs in, typing key by key for the same reason as `fillSignupCredentials`.
 */
async function signIn(page: Page, email: string, password: string) {
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

/**
 * Crosses from the CRM into the account console.
 *
 * Every account, administrators included, lands in the CRM after signing in, so
 * the console is reached through the sidebar. Waiting for the landing URL first
 * keeps the click from racing the redirect that follows login.
 */
async function openAdminWorkspace(page: Page) {
  const link = page.getByRole('link', { name: 'Администрирование' })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/admin$/)
}
