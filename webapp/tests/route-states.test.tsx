import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { dealPath, type UserDto, type UserRole } from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { TooltipProvider } from '../src/components/ui/tooltip'
import { SessionLoadingSection } from '../src/components/WebRouteSections'
import { AuthContext, type AuthContextValue } from '../src/features/auth/context'
import { UserWorkspaceLayout } from '../src/pages'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'

test('session loading exposes one document heading and a reduced-motion status', () => {
  const markup = renderToStaticMarkup(<SessionLoadingSection />)

  expect(markup.match(/<main/g)?.length).toBe(1)
  expect(markup.match(/<h1/g)?.length).toBe(1)
  expect(markup).toContain('Loading workspace')
  expect(markup).toContain('Checking session...')
  expect(markup).toContain('aria-label="Loading"')
  expect(markup).toContain('motion-reduce:animate-none')
})

/* ------------------------------------------------------------------ *
 * The guarded `/app` layout (PRD 3, PRD 10)
 * ------------------------------------------------------------------ */

/**
 * `/app` serves two things at once — the administrator-only CRM product and the
 * account area — so the guard on it has to answer per path. These cases pin what a
 * person actually sees: a plain account gets its account screens and no product
 * chrome, an administrator gets the product.
 *
 * A refused path renders nothing at all: the redirect happens in an effect, which
 * static rendering never runs, so the absence of the shell IS the observable
 * signal that the guard did not let the screen through.
 */
test('a plain account renders its own account area inside the workspace shell', async () => {
  const markup = await renderWorkspaceAt('/app/settings', 'user')

  expect(markup).toContain('Настройки')
  expect(markup).not.toContain('Сделки')
  expect(markup).not.toContain('Дашборд')
  expect(markup).not.toContain('Воронка')
  expect(markup).not.toContain('Задачи')
  expect(markup).not.toContain('Администрирование')
})

test('a plain account is refused every CRM product path', async () => {
  for (const path of ['/app/deals', '/app/board', '/app/dashboard', dealPath(DEAL_ID)]) {
    const markup = await renderWorkspaceAt(path, 'user')
    expect(`${path} -> ${markup}`).toBe(`${path} -> `)
  }
})

test('an administrator is served the CRM product and its sidebar', async () => {
  const markup = await renderWorkspaceAt('/app/deals', 'admin')

  expect(markup).toContain('Сделки')
  expect(markup).toContain('Дашборд')
  expect(markup).toContain('Администрирование')
})

/**
 * The bell calls `/api/notifications`, which is administrator-only, and the backend
 * writes notifications for administrators alone. Mounting it for everybody made
 * every page of a plain account's account area take a 403.
 */
test('the notification bell follows the same rule as the inbox screen', async () => {
  expect(await renderWorkspaceAt('/app/settings', 'user')).not.toContain(
    'aria-label="Уведомления"',
  )
  expect(await renderWorkspaceAt('/app/deals', 'admin')).toContain('aria-label="Уведомления"')
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Renders the real guarded layout at `path` for an account with `role`.
 *
 * The session is supplied through `AuthContext` rather than through the query
 * cache, so nothing here depends on the transport: the guard under test reads only
 * the user and the location.
 */
async function renderWorkspaceAt(path: string, role: UserRole) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    // The same providers `main.tsx` puts above the router, minus the transport:
    // the sidebar's collapsed labels are tooltips, and the notification bell is a
    // query.
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthContext.Provider value={authValue(role)}>
            <UserWorkspaceLayout />
          </AuthContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  })
  const routeTree = rootRoute.addChildren(
    [
      '/app',
      '/app/settings',
      '/app/profile',
      '/app/deals',
      '/app/board',
      '/app/dashboard',
      dealPath('$dealId'),
    ].map((childPath) =>
      createRoute({ getParentRoute: () => rootRoute, path: childPath, component: () => null }),
    ),
  )
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    // Said outright rather than inferred from the absence of a DOM: the router
    // reaches for `window.origin` on the browser path, and `withStubbedDocument`
    // below briefly makes this process look like one.
    isServer: true,
  })

  await router.load()
  return withStubbedDocument(() => renderToStaticMarkup(<RouterProvider router={router} />))
}

/**
 * The workspace shell reads the persisted sidebar state from `document.cookie`
 * while it renders, and these tests run without a DOM. An empty cookie jar is what
 * a first visit looks like.
 *
 * The stub is installed only around the synchronous render and removed afterwards.
 * A module-level stub would leak: `bun test` shares one process across files, and
 * the sibling suites that use `renderInRouter` let the router infer that it is on
 * a server from the absence of `document` — a lingering stub sends them down the
 * browser path and they die on `window`.
 */
function withStubbedDocument<Result>(render: () => Result): Result {
  if ('document' in globalThis) return render()

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: '' },
    writable: true,
  })
  try {
    return render()
  } finally {
    Reflect.deleteProperty(globalThis, 'document')
  }
}

function authValue(role: UserRole): AuthContextValue {
  const user: UserDto = {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'owner@teraso.com.ua',
    displayName: 'Руководитель',
    role,
    createdAt: '2026-07-20T08:30:00.000Z',
  }

  return {
    user,
    isAuthenticated: true,
    isBootstrapping: false,
    sessionError: null,
    retrySession: async () => undefined,
    register: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    requestPasswordReset: async () => undefined,
    confirmPasswordReset: async () => undefined,
    transport: {} as AuthContextValue['transport'],
  }
}
