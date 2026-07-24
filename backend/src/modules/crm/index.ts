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

export function createCrmModule({ clock = systemClock, db, requireAuth }: CreateCrmModuleOptions) {
  const service = new CrmService({ clock, repository: createPrismaCrmRepository(db) })
  return createCrmRoutes({ requireAuth, service })
}

export { CrmService } from './application/crm-service'
export type { CrmRepository } from './application/ports'
