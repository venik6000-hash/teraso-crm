import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router'

import { cleanDealListSearch, DEAL_DETAIL_ROUTE_PATH } from './features/crm'
import { RootLayout } from './root-layout'

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: lazyRouteComponent(() => import('./pages'), 'NotFoundPage'),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>) => ({
    returnTo: typeof search.returnTo === 'string' ? search.returnTo : undefined,
  }),
  component: lazyRouteComponent(() => import('./pages'), 'HomePage'),
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: returnToSearch,
  component: lazyRouteComponent(() => import('./pages'), 'LoginPage'),
})

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signup',
  validateSearch: returnToSearch,
  component: lazyRouteComponent(() => import('./pages'), 'SignupPage'),
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(() => import('./pages'), 'ForgotPasswordPage'),
})

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: lazyRouteComponent(() => import('./pages'), 'ResetPasswordPage'),
})

const userWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'userWorkspace',
  component: lazyRouteComponent(() => import('./pages'), 'UserWorkspaceLayout'),
})

const userHomeRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app',
  component: lazyRouteComponent(() => import('./pages'), 'UserHomePage'),
})

const crmDashboardRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/dashboard',
  component: lazyRouteComponent(() => import('./pages'), 'CrmDashboardRoutePage'),
})

/**
 * The deals list keeps its filters, sorting and page in the URL, so a view is
 * shareable and the back button behaves. `validateSearch` degrades a stale or
 * hand-edited link to the default view instead of failing navigation.
 */
const crmDealsRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/deals',
  validateSearch: (search: Record<string, unknown>) => cleanDealListSearch(search),
  component: lazyRouteComponent(() => import('./pages'), 'CrmDealsRoutePage'),
})

/**
 * Must stay equal to `dealPath()` from the contracts package: the backend
 * stores that value in every notification and the service worker opens it.
 */
const crmDealRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: DEAL_DETAIL_ROUTE_PATH,
  component: lazyRouteComponent(() => import('./pages'), 'CrmDealRoutePage'),
})

const crmBoardRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/board',
  component: lazyRouteComponent(() => import('./pages'), 'CrmBoardRoutePage'),
})

const crmTasksRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/tasks',
  component: lazyRouteComponent(() => import('./pages'), 'CrmTasksRoutePage'),
})

const crmNotificationsRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/notifications',
  component: lazyRouteComponent(() => import('./pages'), 'CrmNotificationsRoutePage'),
})

const userProfileRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/profile',
  component: lazyRouteComponent(() => import('./pages'), 'UserProfilePage'),
})

const userSettingsRoute = createRoute({
  getParentRoute: () => userWorkspaceRoute,
  path: '/app/settings',
  component: lazyRouteComponent(() => import('./pages'), 'UserSettingsPage'),
})

const adminWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'adminWorkspace',
  component: lazyRouteComponent(() => import('./pages'), 'AdminWorkspaceLayout'),
})

const adminDashboardRoute = createRoute({
  getParentRoute: () => adminWorkspaceRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('./pages'), 'AdminDashboardPage'),
})

const adminUsersRoute = createRoute({
  getParentRoute: () => adminWorkspaceRoute,
  path: '/admin/users',
  component: lazyRouteComponent(() => import('./pages'), 'AdminUsersPage'),
})

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminWorkspaceRoute,
  path: '/admin/settings',
  component: lazyRouteComponent(() => import('./pages'), 'AdminSettingsPage'),
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  userWorkspaceRoute.addChildren([
    userHomeRoute,
    crmDashboardRoute,
    crmDealsRoute,
    crmDealRoute,
    crmBoardRoute,
    crmTasksRoute,
    crmNotificationsRoute,
    userProfileRoute,
    userSettingsRoute,
  ]),
  adminWorkspaceRoute.addChildren([
    adminDashboardRoute,
    adminUsersRoute,
    adminSettingsRoute,
  ]),
])

export const router = createRouter({ routeTree })

function returnToSearch(search: Record<string, unknown>) {
  return {
    returnTo: typeof search.returnTo === 'string' ? search.returnTo : undefined,
  }
}

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
