import { z } from 'zod'

import { filterFlagSchema, isoInstantSchema, pageNumberSchema } from './crm'

/* ------------------------------------------------------------------ *
 * Enumerations (mirrored by Prisma enums in backend/prisma/schema.prisma)
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

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

export const notificationSchema = z
  .object({
    id: z.uuid(),
    kind: notificationKindSchema,
    title: z.string(),
    body: z.string(),
    /** In-app destination, always a same-origin path such as /app/deals/<id>. */
    href: z.string(),
    dealId: z.uuid().nullable(),
    eventKey: z.string(),
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

export const notificationListResponseSchema = z
  .object({
    items: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
    page: z.number().int().positive().max(NOTIFICATIONS_MAX_PAGE),
    pageSize: z.number().int().positive().max(NOTIFICATIONS_MAX_PAGE_SIZE),
    total: z.number().int().nonnegative(),
    hasNext: z.boolean(),
  })
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
 */
export const pushSubscriptionCreateSchema = z
  .object({
    endpoint: z.url().max(1000),
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
export type PushSubscriptionParams = z.infer<typeof pushSubscriptionParamsSchema>
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>
