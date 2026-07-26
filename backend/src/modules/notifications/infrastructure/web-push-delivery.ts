import webpush from 'web-push'

import type { PushDelivery, PushPayload, PushSendOutcome, StoredPushSubscription } from '../application/ports'

/**
 * The server-only half of the browser push configuration (PRD 10). It is resolved
 * from the environment in app composition and handed here already validated, so
 * this adapter never reads `process.env` and the private key has exactly one path
 * through the process: env -> composition -> this signing call.
 */
export type VapidConfig = {
  subject: string
  publicKey: string
  privateKey: string
}

/**
 * The provider call, injectable so the mapping below can be tested without a
 * network. It matches the signature of `webpush.sendNotification`.
 */
export type WebPushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { vapidDetails: VapidConfig; TTL: number; timeout: number },
) => Promise<unknown>

/**
 * How long the push service keeps trying to hand the message to a browser that is
 * currently offline. A day matches the dispatcher's own lookback window: past
 * that, the notification is history the in-app centre already holds, and waking a
 * device for it would be noise.
 */
const PUSH_TTL_SECONDS = 24 * 60 * 60

/**
 * Socket timeout for one send.
 *
 * Node's `https.request` has no default timeout, so without this a push service
 * that accepts the connection and then never answers holds the request open
 * forever. The dispatcher sends serially, so that is not one lost notification —
 * it is a delivery pass that never ends, on the least-supervised path in the
 * system, where nothing is watching to notice. Ten seconds is far beyond any
 * healthy push service and far below the pass budget above it.
 */
const PUSH_TIMEOUT_MS = 10_000

/**
 * The two status codes that mean the endpoint itself is gone for good — the user
 * cleared site data, uninstalled the PWA, or the browser rotated it. Anything
 * else (429, 5xx, a timeout, a DNS failure) is a transient condition where the
 * same endpoint may well work an hour from now, so it must NOT retire it.
 *
 * This distinction is the whole reason the outcome is a union rather than a
 * boolean: deleting a subscription on a 500 would silently unsubscribe a user
 * from every future alert because their push service had a bad afternoon.
 */
const TERMINAL_STATUS_CODES = new Set([404, 410])

const defaultSender: WebPushSender = (subscription, payload, options) =>
  webpush.sendNotification(subscription, payload, options)

/**
 * The `web-push` adapter. Payload encryption and VAPID signing belong to the SDK;
 * this layer owns only the translation from a provider rejection to the outcome
 * the service acts on.
 *
 * A missing config yields an adapter that reports `configured: false` and never
 * calls the provider. That is a supported deployment, not a broken one: PRD 7.7
 * makes the in-app centre the source of truth, so a CRM with no VAPID pair still
 * records every notification and simply marks it SKIPPED.
 */
export function createWebPushDelivery(
  config: VapidConfig | undefined,
  sender: WebPushSender = defaultSender,
): PushDelivery {
  if (!config) return disabledPushDelivery

  return {
    configured: true,
    async send(subscription: StoredPushSubscription, payload: PushPayload): Promise<PushSendOutcome> {
      try {
        await sender(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          { vapidDetails: config, TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS },
        )
        return { status: 'sent' }
      } catch (error) {
        const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
        if (typeof statusCode === 'number' && TERMINAL_STATUS_CODES.has(statusCode)) {
          return { status: 'expired' }
        }
        return { status: 'failed', reason: describeFailure(error) }
      }
    },
  }
}

/** The no-VAPID adapter. Exported so composition can name the disabled case. */
export const disabledPushDelivery: PushDelivery = {
  configured: false,
  async send(): Promise<PushSendOutcome> {
    return { status: 'failed', reason: 'push delivery is not configured' }
  },
}

/**
 * A short, loggable reason. The subscription keys and the payload are never part
 * of it: this string reaches the server log, and a push endpoint plus its
 * encryption keys are enough to send a user arbitrary notifications.
 */
function describeFailure(error: unknown): string {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === 'number') return `push service returned ${statusCode}`
  return error instanceof Error ? error.message : 'unknown push delivery failure'
}
