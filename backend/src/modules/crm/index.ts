import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth'
import { CrmService } from './application/crm-service'
import type { Clock } from './application/ports'
import { TaskService } from './application/task-service'
import { createPrismaCrmRepository } from './infrastructure/crm-repository'
import { createInboundRoutes, type InboundWebhookConfig } from './transport/inbound-routes'
import { createCrmRoutes } from './transport/routes'

type CreateCrmModuleOptions = {
  clock?: Clock
  db: DbClient
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  webhook: InboundWebhookConfig
}

const systemClock: Clock = { now: () => new Date() }

/**
 * Returns the authenticated router, the constructed service and the inbound
 * webhook router. The two routers share this ONE `CrmService` instance on purpose:
 * Task 5's webhook (`POST /api/crm/inbound/quiz`) is HMAC-signed rather than
 * bearer-authed, and records leads through the same domain rules and clock as the
 * authenticated API. The inbound router is its own unguarded sibling — app.ts
 * mounts it outside the authenticated security glob rather than the module carving
 * an exception into that glob or reconstructing the service.
 */
export function createCrmModule({ clock = systemClock, db, requireAuth, webhook }: CreateCrmModuleOptions) {
  const repository = createPrismaCrmRepository(db)
  const service = new CrmService({ clock, repository })
  const taskService = new TaskService({ clock, repository })
  return {
    service,
    taskService,
    routes: createCrmRoutes({ requireAuth, service, taskService }),
    inboundRoutes: createInboundRoutes({ service, clock, webhook }),
  }
}

export { CrmService } from './application/crm-service'
export { TaskService } from './application/task-service'
export type { CrmRepository } from './application/ports'
export type { InboundWebhookConfig } from './transport/inbound-routes'
