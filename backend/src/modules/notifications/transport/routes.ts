import {
  apiErrorSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationReadRequestSchema,
  notificationReadResponseSchema,
  pushSubscriptionCreateSchema,
  pushSubscriptionParamsSchema,
  pushSubscriptionResponseSchema,
  vapidPublicKeyResponseSchema,
} from '@teraso-crm/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'

import { AppError, validationErrorHook } from '../../../http/errors'
import type { AuthHttpEnv } from '../../auth'
import type { NotificationService } from '../application/notification-service'

const errorContent = { 'application/json': { schema: apiErrorSchema } }
const bearerSecurity = [{ BearerAuth: [] }]

const jsonBody = <Schema>(schema: Schema) => ({
  content: { 'application/json': { schema } },
})

const listNotificationsRoute = createRoute({
  method: 'get',
  path: '/',
  security: bearerSecurity,
  request: { query: notificationListQuerySchema },
  responses: {
    200: { ...jsonBody(notificationListResponseSchema), description: "The caller's own inbox" },
    400: { content: errorContent, description: 'Invalid query' },
    401: { content: errorContent, description: 'Authentication required' },
  },
})

const markReadRoute = createRoute({
  method: 'post',
  path: '/read',
  security: bearerSecurity,
  request: { body: jsonBody(notificationReadRequestSchema) },
  responses: {
    200: { ...jsonBody(notificationReadResponseSchema), description: 'Updated and unread counts' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

const subscribeRoute = createRoute({
  method: 'post',
  path: '/subscriptions',
  security: bearerSecurity,
  request: { body: jsonBody(pushSubscriptionCreateSchema) },
  responses: {
    201: { ...jsonBody(pushSubscriptionResponseSchema), description: 'Stored browser endpoint' },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
    413: { content: errorContent, description: 'Request body is too large' },
    429: { content: errorContent, description: 'Too many requests' },
  },
})

/**
 * Keyed on the subscription id, with no `GET /subscriptions` beside it, and both
 * halves of that are deliberate.
 *
 * The browser never has to remember the id. The server may retire an endpoint on
 * its own (a 404/410 from the push service) without the browser hearing about it,
 * so Task 8 has to re-POST whatever `pushManager.getSubscription()` returns on
 * every boot regardless — and because that POST is an upsert, it hands back the
 * stable row id every time. There is therefore no moment where the client holds a
 * subscription but not its id, which is the only thing a listing endpoint would
 * have provided.
 *
 * Keying on the endpoint instead — the client's natural handle — would mean a push
 * endpoint travelling in a request line. That endpoint is a capability URL:
 * anyone holding it can send that browser notifications, and request lines end up
 * in access logs and proxy traces. Keeping it in a POST body is the reason the id
 * is worth the indirection.
 */
const unsubscribeRoute = createRoute({
  method: 'delete',
  path: '/subscriptions/{subscriptionId}',
  security: bearerSecurity,
  request: { params: pushSubscriptionParamsSchema },
  responses: {
    204: { description: 'Browser endpoint removed' },
    400: { content: errorContent, description: 'Invalid subscription id' },
    401: { content: errorContent, description: 'Authentication required' },
    404: { content: errorContent, description: 'Subscription not found' },
  },
})

/**
 * Declared before `/subscriptions/{subscriptionId}` in registration order below so
 * the literal path can never be read as a subscription id.
 */
const vapidPublicKeyRoute = createRoute({
  method: 'get',
  path: '/vapid-public-key',
  security: bearerSecurity,
  responses: {
    200: {
      ...jsonBody(vapidPublicKeyResponseSchema),
      description: 'The public half of the VAPID pair',
    },
    401: { content: errorContent, description: 'Authentication required' },
    404: { content: errorContent, description: 'Browser push is not configured' },
  },
})

type CreateNotificationRoutesOptions = {
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  service: NotificationService
  /**
   * Resolved in app composition, exactly like the webhook config: the transport
   * layer never reads the environment, and the PRIVATE half of the pair is never
   * passed to this layer at all — it exists only where the SDK signs (PRD 10).
   */
  vapidPublicKey?: string
}

export function createNotificationRoutes({
  requireAuth,
  service,
  vapidPublicKey,
}: CreateNotificationRoutesOptions) {
  const routes = new OpenAPIHono<AuthHttpEnv>({ defaultHook: validationErrorHook })

  /**
   * PRD 10: access is enforced at the API, not only in the interface. Unlike the
   * CRM router — which has to leave `/inbound` unguarded for the HMAC-signed site
   * webhook — every path on this router serves one person's own inbox or their own
   * push endpoints, so the guard is a deliberate catch-all: a route added here
   * later is authenticated by default rather than by remembering to list it.
   */
  routes.use('*', requireAuth)

  routes.openapi(listNotificationsRoute, async (c) => {
    return c.json(await service.list(c.req.valid('query'), c.var.user), 200)
  })

  routes.openapi(markReadRoute, async (c) => {
    return c.json(await service.markRead(c.req.valid('json'), c.var.user), 200)
  })

  // Before the parameterised subscription route: the literal segment must win.
  routes.openapi(vapidPublicKeyRoute, (c) => {
    if (!vapidPublicKey) {
      throw new AppError(404, 'NOT_FOUND', 'Push-уведомления не настроены')
    }
    return c.json({ publicKey: vapidPublicKey }, 200)
  })

  routes.openapi(subscribeRoute, async (c) => {
    const subscription = await service.subscribe(c.req.valid('json'), c.var.user)
    return c.json({ subscription }, 201)
  })

  routes.openapi(unsubscribeRoute, async (c) => {
    const removed = await service.unsubscribe(c.req.valid('param').subscriptionId, c.var.user)
    // A subscription owned by somebody else is indistinguishable from one that
    // does not exist, so this answers 404 either way and never confirms that
    // another user holds that id.
    if (!removed) throw new AppError(404, 'NOT_FOUND', 'Подписка не найдена')
    return c.body(null, 204)
  })

  return routes
}
