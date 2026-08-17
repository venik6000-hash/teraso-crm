import { describe, expect, test } from 'bun:test'

import { createApp } from '../../../app'
import type { DbClient } from '../../../db'
import type { AppEnv } from '../../../env'

const env: AppEnv = {
  PORT: 3000,
  DATABASE_URL: 'postgresql://superuser:superpassword@localhost:54329/teraso_crm',
  JWT_SECRET: 'test-route-secret-at-least-thirty-two-chars-123',
  CORS_ORIGINS: ['https://web.example.com'],
  ACCESS_TOKEN_TTL_SECONDS: 60,
  REFRESH_TOKEN_TTL_DAYS: 30,
  REFRESH_REUSE_GRACE_SECONDS: 10,
  SESSION_ABSOLUTE_TTL_DAYS: 90,
  SESSION_RETENTION_DAYS: 7,
  AUTH_BODY_LIMIT_BYTES: 64 * 1024,
  AUTH_RATE_LIMIT_MAX: 60,
  AUTH_RATE_LIMIT_WINDOW_SECONDS: 60,
  SHUTDOWN_GRACE_SECONDS: 20,
  TRUST_PROXY: false,
  COOKIE_SECURE: false,
  SPACES_UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
  SPACES_UPLOAD_URL_TTL_SECONDS: 900,
  SPACES_DOWNLOAD_URL_TTL_SECONDS: 300,
  SPACES_PUBLIC_CACHE_CONTROL: 'public, max-age=31536000, immutable',
}

/**
 * The Prisma client is deliberately a stub. Every request in this file must be
 * rejected before it reaches persistence, so a query reaching this object would
 * throw and fail the test — which is the property being checked.
 */
const app = createApp({ env, prisma: {} as DbClient })

const notificationId = '01912d4e-4444-7000-8000-000000000004'
const subscriptionId = '01912d4e-5555-7000-8000-000000000005'

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const protectedRequests: ReadonlyArray<readonly [string, RequestInit | undefined]> = [
  ['/api/notifications', undefined],
  ['/api/notifications?unreadOnly=true&page=2', undefined],
  ['/api/notifications/vapid-public-key', undefined],
  ['/api/notifications/read', jsonInit('POST', { notificationIds: [notificationId] })],
  [
    '/api/notifications/subscriptions',
    jsonInit('POST', {
      endpoint: 'https://push.example/endpoint-1',
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    }),
  ],
  [`/api/notifications/subscriptions/${subscriptionId}`, { method: 'DELETE' }],
]

describe('notification route authentication', () => {
  /**
   * PRD 10: roles are enforced at the API, not only in the interface. Every route
   * on this router carries personal inbox content or a user's own push endpoints,
   * so the guard is a catch-all here — unlike the CRM router, which has to leave
   * room for the unauthenticated inbound webhook.
   *
   * These cases pin the anonymous half of the `requireAuth` + `requireAdmin` pair,
   * which is as far as a stubbed Prisma client reaches. The administrator half — a
   * signed-in `user` account answered 403 — needs real sessions and lives in
   * `notifications.integration.test.ts` under «api access».
   */
  test('rejects every notification route without a bearer token', async () => {
    for (const [path, init] of protectedRequests) {
      const response = await app.request(path, init)

      expect(`${init?.method ?? 'GET'} ${path} -> ${response.status}`).toBe(
        `${init?.method ?? 'GET'} ${path} -> 401`,
      )
      expect((await response.json()).error.code).toBe('UNAUTHORIZED')
    }
  })

  test('rejects a malformed and an unsigned bearer token alike', async () => {
    for (const authorization of ['Bearer not-a-jwt', 'Basic abc123', 'Bearer ']) {
      const response = await app.request('/api/notifications', { headers: { authorization } })

      expect(response.status).toBe(401)
    }
  })

  /**
   * Authentication has to run before validation. If an invalid payload answered
   * 400 to an anonymous caller, the API would confirm which routes and field
   * shapes exist to someone who never signed in.
   */
  test('answers 401 rather than 400 for an unauthenticated invalid payload', async () => {
    const response = await app.request('/api/notifications/read', jsonInit('POST', { nonsense: 1 }))

    expect(response.status).toBe(401)
  })

  /** The private half of the VAPID pair is server-only (PRD 10). */
  test('never exposes the VAPID private key on the public-key route', async () => {
    const configured = createApp({
      env: {
        ...env,
        VAPID_SUBJECT: 'mailto:crm@teraso.com.ua',
        VAPID_PUBLIC_KEY:
          'BOl_yWecy7dd7cqwIR8tarfNq2VkxRE02mfa-NEaqCLA81r8GivBYWAZpmG_zKM6rJFc7vMpSHM9JGIjWEI11GA',
        VAPID_PRIVATE_KEY: 'BUCJiIHPD65Vc69ARTp7LVfMFgnheEm-JEGN5n46Vxw',
      },
      prisma: {} as DbClient,
    })
    const response = await configured.request('/api/notifications/vapid-public-key')
    const raw = await response.text()

    expect(response.status).toBe(401)
    expect(raw).not.toContain('BUCJiIHPD65Vc69ARTp7LVfMFgnheEm-JEGN5n46Vxw')

    const document = await (await configured.request('/openapi.json')).text()
    expect(document).not.toContain('BUCJiIHPD65Vc69ARTp7LVfMFgnheEm-JEGN5n46Vxw')
  })
})

describe('notification route registration', () => {
  test('serves the notification routes in the OpenAPI document', async () => {
    const document = await (await app.request('/openapi.json')).json()

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/notifications',
        '/api/notifications/read',
        '/api/notifications/subscriptions',
        '/api/notifications/subscriptions/{subscriptionId}',
        '/api/notifications/vapid-public-key',
      ]),
    )
  })

  /**
   * The literal `/subscriptions` and `/vapid-public-key` segments must not be
   * swallowed by the list route, and the subscription id route must resolve to a
   * real handler behind auth — a 401 proves the path matched rather than 404ing.
   */
  test('does not let the inbox route shadow the subscription and key routes', async () => {
    for (const path of [
      '/api/notifications/subscriptions',
      '/api/notifications/subscriptions/not-a-uuid',
      '/api/notifications/vapid-public-key',
    ]) {
      const response = await app.request(path)
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 401`)
    }
  })

  /**
   * The inbox is administrator-only (PRD 3) because its bodies carry client names,
   * so the published contract has to say a signed-in caller can still be refused.
   */
  test('documents administrator-only refusal on every notification path', async () => {
    const document = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
    }
    const operations = [
      ['/api/notifications', 'get'],
      ['/api/notifications/read', 'post'],
      ['/api/notifications/subscriptions', 'post'],
      ['/api/notifications/subscriptions/{subscriptionId}', 'delete'],
      ['/api/notifications/vapid-public-key', 'get'],
    ] as const

    for (const [path, method] of operations) {
      const documented = document.paths[path]?.[method]?.responses ?? {}
      expect(`${method} ${path} -> ${Object.hasOwn(documented, '403')}`).toBe(
        `${method} ${path} -> true`,
      )
    }
  })

  test('applies the shared body limit to notification writes', async () => {
    const limited = createApp({ env: { ...env, AUTH_BODY_LIMIT_BYTES: 32 }, prisma: {} as DbClient })
    const response = await limited.request(
      '/api/notifications/subscriptions',
      jsonInit('POST', {
        endpoint: `https://push.example/${'x'.repeat(200)}`,
        keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      }),
    )

    expect(response.status).toBe(413)
  })
})
