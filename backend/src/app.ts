import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import { createBackgroundTasks, type TaskDeferrer } from './background-tasks'
import type { DbClient } from './db'
import { disabledEmailDelivery, type EmailDelivery } from './email/service'
import {
  WEBHOOK_BODY_LIMIT_BYTES_DEFAULT,
  WEBHOOK_MAX_AGE_SECONDS_DEFAULT,
  vapidConfigFrom,
  type AppEnv,
} from './env'
import { errorResponse, handleError, validationErrorHook } from './http/errors'
import { createAuthSecurity } from './http/security'
import { createAuthModule, type AuthHttpEnv } from './modules/auth'
import { createCrmModule } from './modules/crm'
import { createNotificationsModule } from './modules/notifications'
import { createUsersModule } from './modules/users'

type CreateAppOptions = {
  backgroundTasks?: TaskDeferrer
  emailDelivery?: EmailDelivery
  env: AppEnv
  prisma: DbClient
}

export function createApp({
  backgroundTasks = createBackgroundTasks(),
  emailDelivery = disabledEmailDelivery,
  env,
  prisma,
}: CreateAppOptions) {
  const auth = createAuthModule({ backgroundTasks, db: prisma, emailDelivery, env })
  const users = createUsersModule({
    db: prisma,
    requireAdmin: auth.requireAdmin,
    requireAuth: auth.requireAuth,
  })
  /**
   * Built BEFORE the CRM module, which receives its announcement port. The
   * notifications context reads CRM facts; the CRM context is handed a port and
   * imports nothing back, so this one line is the whole seam between them.
   *
   * The VAPID pair is validated as a group in env.ts, so the presence of the
   * public key is enough to know the private half is there too. The private key
   * goes no further than the delivery adapter (PRD 10).
   */
  const notifications = createNotificationsModule({
    backgroundTasks,
    db: prisma,
    requireAuth: auth.requireAuth,
    taskOverdueAfterMinutes: env.NOTIFICATION_TASK_OVERDUE_AFTER_MINUTES,
    vapid: vapidConfigFrom(env),
  })
  const crm = createCrmModule({
    db: prisma,
    notifier: notifications.leadNotifier,
    requireAuth: auth.requireAuth,
    // The signing secret is server-only (PRD 10); the two limits fall back to their
    // documented defaults when the optional env vars are unset.
    webhook: {
      secret: env.TERASO_WEBHOOK_SECRET,
      maxAgeSeconds: env.TERASO_WEBHOOK_MAX_AGE_SECONDS ?? WEBHOOK_MAX_AGE_SECONDS_DEFAULT,
      bodyLimitBytes: env.TERASO_WEBHOOK_BODY_LIMIT_BYTES ?? WEBHOOK_BODY_LIMIT_BYTES_DEFAULT,
    },
  })
  const app = new OpenAPIHono<AuthHttpEnv>({
    defaultHook: validationErrorHook,
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })

  app.use(secureHeaders())
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.CORS_ORIGINS[0] ?? null
        return env.CORS_ORIGINS.includes(origin) ? origin : null
      },
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
      maxAge: 600,
    }),
  )
  for (const middleware of createAuthSecurity({
    bodyLimitBytes: env.AUTH_BODY_LIMIT_BYTES,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
    rateLimitWindowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    trustProxy: env.TRUST_PROXY,
    trustedProxyClientIpHeader: env.TRUSTED_PROXY_CLIENT_IP_HEADER,
    trustedProxyClientIpPosition: env.TRUSTED_PROXY_CLIENT_IP_POSITION,
  })) {
    app.use('/api/auth/*', middleware)
  }
  for (const middleware of createAuthSecurity({
    bodyLimitBytes: env.AUTH_BODY_LIMIT_BYTES,
    rateLimitMax: env.AUTH_RATE_LIMIT_MAX,
    rateLimitWindowSeconds: env.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    trustProxy: env.TRUST_PROXY,
    trustedProxyClientIpHeader: env.TRUSTED_PROXY_CLIENT_IP_HEADER,
    trustedProxyClientIpPosition: env.TRUSTED_PROXY_CLIENT_IP_POSITION,
  })) {
    app.use('/api/users/*', middleware)
    app.use('/api/admin/*', middleware)
    // Scoped to the authenticated CRM surface, not a blanket /api/crm/* glob, so
    // Task 5's HMAC-signed webhook can mount under /api/crm/inbound without
    // inheriting bearer-auth rate limiting or the auth body limit.
    app.use('/api/crm/deals', middleware)
    app.use('/api/crm/deals/*', middleware)
    app.use('/api/crm/tasks', middleware)
    app.use('/api/crm/tasks/*', middleware)
    app.use('/api/crm/clients/*', middleware)
    // The whole notification surface is bearer-authenticated, so unlike the CRM
    // prefixes above it needs no carve-out for an unauthenticated sibling.
    app.use('/api/notifications', middleware)
    app.use('/api/notifications/*', middleware)
  }
  app.get('/', (c) => {
    return c.json({
      name: 'Teraso CRM backend',
      status: 'ok',
    })
  })

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
    })
  })

  app.get('/health/live', (c) => {
    return c.json({
      status: 'ok',
    })
  })

  app.get('/health/ready', async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return c.json({ status: 'ok' }, 200)
    } catch {
      return c.json({ status: 'unavailable' }, 503)
    }
  })

  app.route('/api/auth', auth.routes)
  app.route('/api/users', users.userRoutes)
  app.route('/api/admin', users.adminRoutes)
  // The HMAC-signed site webhook, mounted as a sibling BEFORE the authenticated CRM
  // router and outside the auth security glob above: it authenticates by signature,
  // not a bearer token, so it must not inherit `requireAuth`, the auth rate-limiter
  // or the auth body limit. `crm.routes` defines no `/inbound/*` path, so the two
  // never collide.
  app.route('/api/crm/inbound', crm.inboundRoutes)
  app.route('/api/crm', crm.routes)
  app.route('/api/notifications', notifications.routes)

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Teraso CRM API',
      version: '1.0.0',
    },
  })

  app.notFound((c) => c.json(errorResponse('NOT_FOUND', 'Route not found'), 404))
  app.onError(handleError)

  return app
}

export type AppType = ReturnType<typeof createApp>
