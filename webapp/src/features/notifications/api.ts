import {
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationReadRequestSchema,
  notificationReadResponseSchema,
  pushSubscriptionCreateSchema,
  pushSubscriptionResponseSchema,
  vapidPublicKeyResponseSchema,
  type NotificationListQuery,
  type PushSubscriptionCreateInput,
} from '@teraso-crm/contracts'

import type { AuthenticatedTransport } from '@/platform/api'

/**
 * The notification centre's typed data boundary.
 *
 * Same contract as the CRM's api.ts: requests are parsed through the shared
 * request schema on the way out, responses through the strict response schema
 * on the way in, and nothing here imports React.
 */

const NOTIFICATIONS_BASE = '/api/notifications'

export function listNotifications(
  transport: AuthenticatedTransport,
  input: NotificationListQuery,
) {
  const query = notificationListQuerySchema.parse(input)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // A flag that is off means "no constraint", so it is left out entirely.
    if (value === undefined || value === false) continue
    search.set(key, String(value))
  }
  return transport.request(`${NOTIFICATIONS_BASE}?${search}`, notificationListResponseSchema)
}

/**
 * Marks a batch read. The caller passes ids from `unreadIdsToMark`, which caps
 * the batch — this is one request no matter how full the inbox is, because the
 * endpoint shares a rate bucket with every CRM write.
 */
export function markNotificationsRead(
  transport: AuthenticatedTransport,
  notificationIds: ReadonlyArray<string>,
) {
  return transport.request(`${NOTIFICATIONS_BASE}/read`, notificationReadResponseSchema, {
    method: 'POST',
    body: notificationReadRequestSchema.parse({ notificationIds }),
  })
}

/**
 * The public half of the VAPID pair. A deployment with push unconfigured
 * answers 404, which the card presents as "push is unavailable, the inbox still
 * works" rather than as an error.
 */
export async function getVapidPublicKey(transport: AuthenticatedTransport) {
  const response = await transport.request(
    `${NOTIFICATIONS_BASE}/vapid-public-key`,
    vapidPublicKeyResponseSchema,
  )
  return response.publicKey
}

/**
 * Registers this browser's push endpoint.
 *
 * Re-sending an existing subscription is expected rather than wasteful: the
 * server can retire an endpoint on a 404/410 from the push service without the
 * browser ever hearing about it, so the app re-posts whatever
 * `pushManager.getSubscription()` returns on boot. The endpoint upserts and
 * answers with the stable row id, which is why the browser never has to persist
 * one itself.
 */
export async function subscribeToPush(
  transport: AuthenticatedTransport,
  input: PushSubscriptionCreateInput,
) {
  const response = await transport.request(
    `${NOTIFICATIONS_BASE}/subscriptions`,
    pushSubscriptionResponseSchema,
    { method: 'POST', body: pushSubscriptionCreateSchema.parse(input) },
  )
  return response.subscription
}
