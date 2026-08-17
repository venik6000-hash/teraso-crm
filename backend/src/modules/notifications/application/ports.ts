import type {
  NotificationDeliveryState,
  NotificationKind,
  NotificationListQuery,
  NotificationListResponse,
  NotificationReadResponse,
  PushSubscriptionDto,
} from '@teraso-crm/contracts'

/* ------------------------------------------------------------------ *
 * The public write port (PRD 7.7)
 * ------------------------------------------------------------------ */

/**
 * One durable inbox record. `eventKey` is the idempotency identity: it is
 * deterministic per (recipient, fact), so a cron run that overlaps the previous
 * one writes the same key and the `[recipientUserId, eventKey]` unique index
 * collapses the duplicate instead of sending a second push.
 *
 * The key is unique PER RECIPIENT rather than globally, so one fact can reach
 * several people once the manager role of PRD 3 ships.
 */
export type NotificationCreateInput = {
  recipientUserId: string
  kind: NotificationKind
  title: string
  body: string
  href: string
  eventKey: string
  dealId?: string | null
}

/**
 * The notifications context's public write port. Other bounded contexts announce
 * a committed fact through this and nothing else; they never reach the repository,
 * the delivery adapter or the inbox reads.
 */
export interface NotificationWriter {
  create(input: NotificationCreateInput): Promise<void>
}

/* ------------------------------------------------------------------ *
 * Cron conditions
 * ------------------------------------------------------------------ */

/**
 * An ACTIVE task on an OPEN deal whose due instant has already passed. It carries
 * the due instant itself rather than a flag, because both event keys the service
 * derives from it are anchored on that instant — never on `now`, which would fire
 * a fresh notification every single minute.
 */
export type DueTaskCondition = {
  taskId: string
  dealId: string
  title: string
  dueAt: Date
  assigneeUserId: string | null
  clientName: string
}

/**
 * An OPEN deal that has used up its next-step grace window without a future
 * active task. The criticality decision itself is made by the CRM domain rule
 * (`evaluateDealCriticality`) inside the repository, so this module never
 * restates it; `createdAt` is here because the event key is anchored on
 * creation plus the grace window, the instant the condition began.
 */
export type LeadNeedsActionCondition = {
  dealId: string
  createdAt: Date
  responsibleUserId: string | null
  clientName: string
}

/** A committed inbound lead, as announced by the CRM context. */
export type NewLeadFact = {
  dealId: string
  clientId: string
  clientName: string
  source: string
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/** An unread, undelivered notification queued for a best-effort push. */
export type DeliverableNotification = {
  id: string
  recipientUserId: string
  kind: NotificationKind
  title: string
  body: string
  href: string
}

/** A stored browser endpoint. The keys never leave the server (PRD 10). */
export type StoredPushSubscription = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

export type PushSubscriptionCreateCommand = {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
}

/**
 * The notifications persistence boundary. Like the CRM repository it exposes
 * product operations rather than generic CRUD and returns response DTOs directly.
 *
 * Every read that serves a user takes `recipientUserId`/`userId` as its FIRST
 * argument, so scoping a query to its owner is a parameter the caller cannot
 * forget rather than a filter a future edit could drop.
 */
export type NotificationRepository = NotificationWriter & {
  /**
   * Idempotent bulk insert: an existing `[recipient, eventKey]` row is left alone.
   * Returns how many rows were actually written, which is what makes the cron log
   * an honest signal — a repeat or overlapping run reports 0 rather than implying
   * it announced everything a second time.
   */
  createMany(inputs: NotificationCreateInput[]): Promise<number>

  listForRecipient(
    recipientUserId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResponse>

  markRead(recipientUserId: string, notificationIds: string[], now: Date): Promise<NotificationReadResponse>

  listPendingDeliveries(limit: number): Promise<DeliverableNotification[]>

  /** The unsent records for one event key, so a trigger can push just its own. */
  listPendingDeliveriesForEvent(eventKey: string): Promise<DeliverableNotification[]>

  /**
   * Atomically takes one record off PENDING for sending. False means another pass
   * already owns it and this one must not send it too. See the implementation for
   * why the claim is written as a terminal state rather than an in-flight one.
   */
  claimForDelivery(notificationId: string): Promise<boolean>

  markDelivered(notificationId: string, state: NotificationDeliveryState): Promise<void>

  /**
   * Every administrator, as the recipients of a notification nobody owns
   * personally.
   *
   * It is a list rather than a single id because PRD 3's deferred manager role
   * will add recipients, so the fan-out already has the shape it needs. It is
   * NOT every user: notification bodies carry client names and link at deal
   * cards, both of which the CRM API serves to administrators alone, so a
   * plain account must not be handed the same facts through its inbox.
   */
  listRecipientUserIds(): Promise<string[]>

  /** ACTIVE tasks on OPEN deals whose due instant falls inside the scanned window. */
  findDueTaskConditions(window: { dueFrom: Date; dueTo: Date }): Promise<DueTaskCondition[]>

  /**
   * OPEN deals created no earlier than `createdFrom` that have no future active
   * task at `now`. The repository applies the CRM's own next-step grace cutoff and
   * criticality rule, so this module never restates either.
   */
  findLeadNeedsActionConditions(window: {
    createdFrom: Date
    now: Date
  }): Promise<LeadNeedsActionCondition[]>

  createSubscription(command: PushSubscriptionCreateCommand): Promise<PushSubscriptionDto>

  /** Returns false when the id does not exist OR belongs to somebody else. */
  deleteSubscription(userId: string, subscriptionId: string): Promise<boolean>

  /** Retires one dead endpoint after a terminal 404/410; notifications are kept. */
  deleteSubscriptionByEndpoint(endpoint: string): Promise<void>

  listSubscriptions(userId: string): Promise<StoredPushSubscription[]>
}

/* ------------------------------------------------------------------ *
 * Browser push delivery
 * ------------------------------------------------------------------ */

/** What the service worker receives. It carries no personal data beyond the copy. */
export type PushPayload = {
  notificationId: string
  kind: NotificationKind
  title: string
  body: string
  href: string
}

/**
 * `expired` is the ONLY outcome that retires a subscription, and it is reserved
 * for a terminal 404 or 410 from the push service. Every other failure —
 * timeout, network error, 429, 5xx — is `failed`: the endpoint may well work
 * next time, and the inbox record is retained either way (PRD 7.7).
 */
export type PushSendOutcome =
  | { status: 'sent' }
  | { status: 'expired' }
  | { status: 'failed'; reason: string }

export type PushDelivery = {
  /** False when no VAPID pair is configured; the inbox then works on its own. */
  readonly configured: boolean
  send(subscription: StoredPushSubscription, payload: PushPayload): Promise<PushSendOutcome>
}

export type Clock = {
  now(): Date
}
