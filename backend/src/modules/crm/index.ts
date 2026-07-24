import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth'
import { CrmService } from './application/crm-service'
import type { Clock } from './application/ports'
import { createPrismaCrmRepository } from './infrastructure/crm-repository'
import { createCrmRoutes } from './transport/routes'

type CreateCrmModuleOptions = {
  clock?: Clock
  db: DbClient
  requireAuth: MiddlewareHandler<AuthHttpEnv>
}

const systemClock: Clock = { now: () => new Date() }

/**
 * Returns the authenticated router and the constructed service. Exposing the
 * service is deliberate: Task 5's inbound webhook (`POST /api/crm/inbound/quiz`)
 * is HMAC-signed rather than bearer-authed, and it must reuse this exact
 * `CrmService` instance to record leads through the same domain rules. It mounts
 * its own unguarded sibling router instead of reconstructing the service or
 * carving an exception out of the authenticated security glob in app.ts.
 */
export function createCrmModule({ clock = systemClock, db, requireAuth }: CreateCrmModuleOptions) {
  const service = new CrmService({ clock, repository: createPrismaCrmRepository(db) })
  return {
    service,
    routes: createCrmRoutes({ requireAuth, service }),
  }
}

export { CrmService } from './application/crm-service'
export type { CrmRepository } from './application/ports'
