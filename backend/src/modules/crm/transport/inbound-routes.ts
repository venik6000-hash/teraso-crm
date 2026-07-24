import { inboundQuizLeadSchema } from '@teraso-crm/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'

import { AppError, errorResponse, validationErrorResponse } from '../../../http/errors'
import type { Clock } from '../application/ports'
import type { CrmService } from '../application/crm-service'
import { toCrmAppError } from './errors'

/**
 * Server-only configuration for the Teraso site webhook (PRD 8, PRD 10). `secret`
 * is optional so the service still boots without it; when it is absent the route
 * fail-closes and rejects every delivery, rather than silently accepting unsigned
 * traffic. `maxAgeSeconds` and `bodyLimitBytes` are resolved (with their defaults)
 * in app.ts before the router is built, so the transport layer never reads env.
 */
export type InboundWebhookConfig = {
  secret?: string
  maxAgeSeconds: number
  bodyLimitBytes: number
}

type CreateInboundRoutesOptions = {
  service: CrmService
  clock: Clock
  webhook: InboundWebhookConfig
}

type RejectionReason = 'signature' | 'age' | 'body-limit' | 'validation'

/**
 * The Teraso site webhook. It is a plain Hono router, not an OpenAPIHono like the
 * bearer-authed CRM routes: it must read the EXACT raw body bytes to verify the
 * HMAC, and an OpenAPI zod body validator would parse and re-shape the body first,
 * so key order and whitespace would differ and every signature would fail.
 *
 * The site is authenticated by an HMAC-SHA256 signature over
 * `${x-teraso-timestamp}.${raw body}`, so this router mounts OUTSIDE `requireAuth`
 * and outside the auth rate-limiter, with its own body limit. See app.ts.
 */
export function createInboundRoutes({ service, clock, webhook }: CreateInboundRoutesOptions) {
  const routes = new Hono()

  // The webhook's own body limit, independent of the auth surface. A body over the
  // limit is refused here before the signature is even computed.
  routes.use(
    '/quiz',
    bodyLimit({
      maxSize: webhook.bodyLimitBytes,
      onError: (c) => {
        logRejectedDelivery('body-limit', 'payload exceeds the configured webhook body limit')
        return c.json(errorResponse('PAYLOAD_TOO_LARGE', 'Тело запроса слишком большое'), 413)
      },
    }),
  )

  routes.post('/quiz', async (c) => {
    // The exact received bytes, used verbatim for the HMAC — never a re-serialized
    // JSON parse, whose key order and whitespace would not match the site's.
    const rawBody = await c.req.text()
    const timestamp = c.req.header('x-teraso-timestamp')
    const signature = c.req.header('x-teraso-signature')

    if (!webhook.secret) {
      logRejectedDelivery('signature', 'webhook secret is not configured; failing closed')
      return unauthorized(c, 'Недействительная подпись вебхука')
    }
    if (!timestamp || !signature) {
      logRejectedDelivery('signature', 'missing x-teraso-timestamp or x-teraso-signature header')
      return unauthorized(c, 'Недействительная подпись вебхука')
    }
    if (!isValidSignature(webhook.secret, timestamp, rawBody, signature)) {
      logRejectedDelivery('signature', 'HMAC signature did not match')
      return unauthorized(c, 'Недействительная подпись вебхука')
    }
    // Freshness is checked only after the signature is verified, so the timestamp it
    // reads is authenticated rather than attacker-chosen.
    if (!isFresh(timestamp, webhook.maxAgeSeconds, clock.now())) {
      logRejectedDelivery('age', 'signed timestamp is outside the freshness window')
      return unauthorized(c, 'Устаревшая подпись вебхука')
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      logRejectedDelivery('validation', 'body is not valid JSON')
      return c.json(validationErrorResponse('Тело запроса не является корректным JSON'), 400)
    }

    const parsed = inboundQuizLeadSchema.safeParse(payload)
    if (!parsed.success) {
      logRejectedDelivery('validation', 'payload failed inboundQuizLeadSchema')
      return c.json(validationErrorResponse(parsed.error.issues), 400)
    }

    try {
      const result = await service.recordInboundQuizLead(parsed.data)
      // A redelivery persisted nothing new, so it is 200; every path that wrote a
      // receipt (created, new deal, or attached to an open deal) is 201.
      return c.json(result, result.status === 'duplicate-delivery' ? 200 : 201)
    } catch (error) {
      // A phone that cannot identify a Ukrainian client is a validation failure, not
      // a server error: surface it as the CrmFailure's 400 and log it as such.
      const appError = toCrmAppError(error)
      if (appError instanceof AppError) {
        logRejectedDelivery('validation', appError.message)
        return c.json(errorResponse(appError.code, appError.message, appError.details), appError.status)
      }
      throw error
    }
  })

  return routes
}

function unauthorized(c: Context, message: string) {
  return c.json(errorResponse('UNAUTHORIZED', message), 401)
}

/**
 * Constant-time HMAC comparison. `timingSafeEqual` throws when the buffers differ
 * in length, so lengths are compared first — a forged signature of the wrong size
 * is a plain `false`, never a 500, and a plain `===` timing oracle is avoided.
 */
function isValidSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedHex: string,
): boolean {
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest()
  // A malformed hex string yields a buffer of the wrong length, caught below.
  const provided = Buffer.from(providedHex, 'hex')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

/**
 * The delivery timestamp is Unix epoch SECONDS. The window is two-sided (abs) so a
 * timestamp too far in the future — a sign of a replayed or malfunctioning client —
 * is refused as well, while modest clock skew in either direction is tolerated.
 */
function isFresh(timestamp: string, maxAgeSeconds: number, now: Date): boolean {
  const deliveredAtSeconds = Number(timestamp)
  if (!Number.isFinite(deliveredAtSeconds)) return false
  return Math.abs(now.getTime() / 1000 - deliveredAtSeconds) <= maxAgeSeconds
}

/**
 * Traceability without leakage (PRD 8): the reason and a short detail reach the
 * server log so a failed webhook can be investigated, but the secret, the raw
 * signature and the payload body are never written.
 */
function logRejectedDelivery(reason: RejectionReason, detail: string) {
  console.warn(`[inbound-quiz] rejected delivery (${reason}): ${detail}`)
}
