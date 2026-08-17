import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth'
import { CrmService } from './application/crm-service'
import type { AssignableUsersReader, Clock, LeadNotifier } from './application/ports'
import { TaskService } from './application/task-service'
import { createPrismaCrmRepository } from './infrastructure/crm-repository'
import { createInboundRoutes, type InboundWebhookConfig } from './transport/inbound-routes'
import { createCrmRoutes } from './transport/routes'

type CreateCrmModuleOptions = {
  /**
   * Who a deal may be made responsible for (PRD 7.1). Injected rather than
   * queried, so the roster of people stays owned by the users context and this
   * module never writes SQL over somebody else's table. Required, unlike
   * `notifier`: see `AssignableUsersReader` for why a silent default would hide a
   * wiring mistake instead of degrading gracefully.
   */
  assignableUsers: AssignableUsersReader
  clock?: Clock
  db: DbClient
  /**
   * Where a committed inbound lead is announced (PRD 7.7). It is injected here
   * rather than imported, so this module stays unaware of the notifications
   * context and the dependency between the two runs one way only. Omitting it
   * leaves the CRM silent, which is what every test that predates notifications
   * expects.
   */
  notifier?: LeadNotifier
  /**
   * The role half of the authenticated CRM guard (PRD 3). It is a separate option
   * from `requireAuth` because the two are composed in that order on every guarded
   * path: the session establishes the role the check then reads.
   */
  requireAdmin: MiddlewareHandler<AuthHttpEnv>
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  webhook: InboundWebhookConfig
}

const systemClock: Clock = { now: () => new Date() }

/**
 * Returns the administrator-only router, the constructed service and the inbound
 * webhook router. The two routers share this ONE `CrmService` instance on purpose:
 * Task 5's webhook (`POST /api/crm/inbound/quiz`) is HMAC-signed rather than
 * bearer-authed, and records leads through the same domain rules and clock as the
 * authenticated API. The inbound router is its own unguarded sibling — app.ts
 * mounts it outside the authenticated security glob rather than the module carving
 * an exception into that glob or reconstructing the service.
 */
export function createCrmModule({
  assignableUsers,
  clock = systemClock,
  db,
  notifier,
  requireAdmin,
  requireAuth,
  webhook,
}: CreateCrmModuleOptions) {
  const repository = createPrismaCrmRepository(db)
  const service = new CrmService({ assignableUsers, clock, notifier, repository })
  const taskService = new TaskService({ clock, repository })
  return {
    service,
    taskService,
    routes: createCrmRoutes({ requireAdmin, requireAuth, service, taskService }),
    inboundRoutes: createInboundRoutes({ service, clock, webhook }),
  }
}

export { CrmService } from './application/crm-service'
export { TaskService } from './application/task-service'
export type {
  AssignableUsersReader,
  CrmRepository,
  LeadNotifier,
  NewLeadFact,
} from './application/ports'
export type { InboundWebhookConfig } from './transport/inbound-routes'

/**
 * Server-authoritative urgency, re-exported as part of this context's public API.
 *
 * The notifications context needs the very same rule to decide when a deal has
 * spent its next-step window without a task (PRD 7.7). It reads it from here
 * rather than restating it, because a second copy is exactly what would drift
 * away from the list, the board and the criticality flags they serve.
 */
export { evaluateDealCriticality, nextStepGraceCutoff } from './domain/deal-rules'
export type { DealCriticality } from './domain/deal-rules'
