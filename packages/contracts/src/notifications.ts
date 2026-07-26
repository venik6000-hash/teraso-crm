import { z } from 'zod'

import { APP_PATH_PREFIX } from './app-paths'
import { filterFlagSchema, isoInstantSchema, pageNumberSchema, pageResponse } from './primitives'

/* ------------------------------------------------------------------ *
 * Enumerations (mirrored by Prisma enums in backend/prisma/schema.prisma,
 * value for value and in order; asserted in backend/src/contracts.test.ts)
 * ------------------------------------------------------------------ */

export const notificationKindSchema = z.enum([
  'NEW_LEAD',
  'TASK_DUE',
  'TASK_OVERDUE',
  'LEAD_NEEDS_ACTION',
])

/**
 * Push delivery is best effort and never gates the inbox record: a failed or
 * skipped send still leaves a readable notification (PRD 7.7).
 */
export const notificationDeliveryStateSchema = z.enum(['PENDING', 'SENT', 'FAILED', 'SKIPPED'])

export const NOTIFICATIONS_MAX_PAGE = 1000
export const NOTIFICATIONS_MAX_PAGE_SIZE = 100
export const NOTIFICATIONS_MAX_READ_BATCH = 200

/**
 * An in-app destination. Must be a same-origin absolute path under the webapp's
 * authenticated workspace, because the service worker hands it to
 * `clients.openWindow()` — an absolute URL there would let a stored notification
 * navigate the user off-origin.
 *
 * Requiring `APP_PATH_PREFIX` is the second half of the guarantee in
 * app-paths.ts. `href` is a denormalized stored column, so a producer spelling
 * its own path would commit a dead link to rows that only surfaces when someone
 * clicks a push. Pinning the prefix here turns that into a parse failure at the
 * boundary, on the way in and on the way out.
 *
 * The trailing `/` in the pattern is load-bearing twice over: it forbids a bare
 * `/app` with no destination, and — together with the literal prefix — it rules
 * out the protocol-relative form `//evil.example.com`, which a plain
 * `startsWith('/')` still admits and browsers resolve as cross-origin.
 */
const notificationHrefSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    new RegExp(`^${APP_PATH_PREFIX}/[^/]`),
    'Ссылка уведомления должна вести внутрь приложения',
  )

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

/**
 * `eventKey` is deliberately absent: it is the server's cron-idempotency key,
 * the webapp has no use for it, and this schema is strict, so exposing it would
 * oblige every producer to populate a field nothing reads.
 */
export const notificationSchema = z
  .object({
    id: z.uuid(),
    kind: notificationKindSchema,
    title: z.string(),
    body: z.string(),
    href: notificationHrefSchema,
    dealId: z.uuid().nullable(),
    deliveryState: notificationDeliveryStateSchema,
    readAt: isoInstantSchema.nullable(),
    createdAt: isoInstantSchema,
  })
  .strict()

export const notificationListQuerySchema = z
  .object({
    unreadOnly: filterFlagSchema,
    page: pageNumberSchema(1, NOTIFICATIONS_MAX_PAGE),
    pageSize: pageNumberSchema(20, NOTIFICATIONS_MAX_PAGE_SIZE),
  })
  .strict()

export const notificationListResponseSchema = pageResponse(notificationSchema, {
  maxPage: NOTIFICATIONS_MAX_PAGE,
  maxPageSize: NOTIFICATIONS_MAX_PAGE_SIZE,
})
  .extend({ unreadCount: z.number().int().nonnegative() })
  .strict()

export const notificationReadRequestSchema = z
  .object({
    notificationIds: z.array(z.uuid()).min(1).max(NOTIFICATIONS_MAX_READ_BATCH),
  })
  .strict()

export const notificationReadResponseSchema = z
  .object({
    updatedCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict()

/* ------------------------------------------------------------------ *
 * Browser push subscriptions
 * ------------------------------------------------------------------ */

/**
 * Shaped like the browser's own `PushSubscription.toJSON()` so the webapp can
 * forward it unchanged. `expirationTime` is accepted because the PushManager
 * always sends it and this object is strict.
 *
 * The endpoint is required to be `https:`. This value is a URL the SERVER later
 * dereferences on an unattended schedule, so a bare `z.url()` would let any
 * authenticated user park an internal address here — link-local metadata, a
 * service on the private network — and have the dispatcher connect to it. The
 * body never returns, but `deliveryState` does through `GET /api/notifications`,
 * which makes SENT-versus-FAILED a reachability oracle for arbitrary hosts.
 * Real push services are HTTPS without exception, so this costs nothing.
 *
 * It is not a complete SSRF defence — it does not resolve DNS or exclude private
 * address ranges — and it is not meant to be. Egress restriction belongs to the
 * network, and this closes the part the contract can honestly own.
 */
export const pushSubscriptionCreateSchema = z
  .object({
    endpoint: z.url({ protocol: /^https$/ }).max(1000),
    expirationTime: z.number().nullish(),
    keys: z
      .object({
        p256dh: z.string().min(1).max(300),
        auth: z.string().min(1).max(300),
      })
      .strict(),
    userAgent: z.string().trim().max(300).optional(),
  })
  .strict()

export const pushSubscriptionSchema = z
  .object({
    id: z.uuid(),
    endpoint: z.string(),
    userAgent: z.string().nullable(),
    createdAt: isoInstantSchema,
  })
  .strict()

export const pushSubscriptionResponseSchema = z
  .object({ subscription: pushSubscriptionSchema })
  .strict()

export const pushSubscriptionParamsSchema = z.object({ subscriptionId: z.uuid() }).strict()

/** Only the public half of the VAPID pair ever leaves the server. */
export const vapidPublicKeyResponseSchema = z.object({ publicKey: z.string().min(1) }).strict()

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type NotificationKind = z.infer<typeof notificationKindSchema>
export type NotificationDeliveryState = z.infer<typeof notificationDeliveryStateSchema>
export type NotificationDto = z.infer<typeof notificationSchema>
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>
export type NotificationReadRequest = z.infer<typeof notificationReadRequestSchema>
export type NotificationReadResponse = z.infer<typeof notificationReadResponseSchema>
export type PushSubscriptionCreateInput = z.infer<typeof pushSubscriptionCreateSchema>
export type PushSubscriptionDto = z.infer<typeof pushSubscriptionSchema>
export type PushSubscriptionResponse = z.infer<typeof pushSubscriptionResponseSchema>
export type PushSubscriptionParams = z.infer<typeof pushSubscriptionParamsSchema>
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>
