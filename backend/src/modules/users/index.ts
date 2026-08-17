import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth'
import { UsersService } from './application/users-service'
import { createPrismaUsersRepository } from './infrastructure/users-repository'
import { createUsersRoutes } from './transport/routes'

type CreateUsersModuleOptions = {
  db: DbClient
  requireAdmin: MiddlewareHandler<AuthHttpEnv>
  requireAuth: MiddlewareHandler<AuthHttpEnv>
}

/**
 * Returns this module's two routers plus the narrow reader other contexts consume.
 *
 * `assignableUsersReader` is the whole public surface of "who may own a record":
 * the CRM's «ответственный» picker (PRD 7.1) needs the administrators, and app.ts
 * hands it this and nothing else. It is a fresh object literal with one method
 * rather than the repository or the service itself, so the consumer receives the
 * single capability it asked for and cannot grow to depend on role mutations or
 * the account console's paged reads — the same shape `createLeadNotifier` uses for
 * the port running the other way.
 */
export function createUsersModule(options: CreateUsersModuleOptions) {
  const repository = createPrismaUsersRepository(options.db)
  const service = new UsersService({
    adminDashboardReader: repository,
    adminUsersReader: repository,
    assignableUsersReader: repository,
    clock: { now: () => new Date() },
    profileWriter: repository,
    userRoleUpdater: repository,
  })
  return {
    ...createUsersRoutes({
      requireAdmin: options.requireAdmin,
      requireAuth: options.requireAuth,
      service,
    }),
    assignableUsersReader: {
      listAssignableUsers: () => service.listAssignableUsers(),
    },
  }
}
