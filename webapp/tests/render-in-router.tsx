import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { dealPath } from '@teraso-crm/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Renders a CRM component that contains router links.
 *
 * `@tanstack/react-router`'s `Link` reads the router from context, so a bare
 * `renderToStaticMarkup` throws; and an unloaded router renders nothing at all.
 * The route tree here mirrors only the destinations the CRM links to, so a link
 * pointing at a path the real router does not serve fails to resolve here too.
 */
export async function renderInRouter(node: ReactNode, initialPath = '/app/deals') {
  const rootRoute = createRootRoute({ component: () => node })
  const routeTree = rootRoute.addChildren(
    [
      '/app/deals',
      dealPath('$dealId'),
      '/app/board',
      '/app/tasks',
      '/app/notifications',
      '/app/dashboard',
    ].map(
      (path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => null,
        }),
    ),
  )
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })

  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}
