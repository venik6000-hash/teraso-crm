import type {
  AdminUsersQuery,
  UpdateProfileRequest,
  UpdateUserRoleRequest,
  UserDto,
} from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import type {
  AdminDashboardReader,
  AdminUsersReader,
  AssignableUsersReader,
  Clock,
  ProfileWriter,
  UserRecord,
  UserRoleUpdater,
} from './ports'

type UsersServiceDependencies = {
  adminDashboardReader: AdminDashboardReader
  adminUsersReader: AdminUsersReader
  assignableUsersReader: AssignableUsersReader
  clock: Clock
  profileWriter: ProfileWriter
  userRoleUpdater: UserRoleUpdater
}

export class UsersService {
  constructor(private readonly dependencies: UsersServiceDependencies) {}

  async updateProfile(principal: AuthenticatedPrincipal, input: UpdateProfileRequest) {
    const user = await this.dependencies.profileWriter.updateProfile(
      principal.id,
      input.displayName,
    )
    return {
      user: this.userDto(user),
    }
  }

  dashboard() {
    const createdAfter = new Date(this.dependencies.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000)
    return this.dependencies.adminDashboardReader.dashboard(createdAfter)
  }

  listUsers(query: AdminUsersQuery) {
    return this.dependencies.adminUsersReader.listUsers(query)
  }

  /**
   * The administrators another bounded context may offer as an owner of its own
   * records — today the CRM's «ответственный» picker (PRD 7.1).
   *
   * There is no route for it on this module's routers: it leaves through the
   * narrow reader `createUsersModule` returns, and the consuming context serves it
   * behind its own guards. It goes through the service rather than handing the
   * repository across the boundary so a later policy — excluding a suspended
   * account, say — has an obvious home that is not somebody else's module.
   *
   * No principal argument: the caller's own guard decides who may see the list,
   * and every answer is the same for every administrator.
   */
  listAssignableUsers() {
    return this.dependencies.assignableUsersReader.listAssignableUsers()
  }

  async updateRole(
    principal: AuthenticatedPrincipal,
    targetUserId: string,
    input: UpdateUserRoleRequest,
  ) {
    return {
      user: await this.dependencies.userRoleUpdater.updateRole({
        actorUserId: principal.id,
        targetUserId,
        role: input.role,
        now: this.dependencies.clock.now(),
      }),
    }
  }

  private userDto(user: UserRecord): UserDto {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    }
  }
}
