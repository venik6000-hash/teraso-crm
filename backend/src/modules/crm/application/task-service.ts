import type {
  CriticalTasksResponse,
  DealTaskDto,
  TaskCreateInput,
  TaskUpdateInput,
} from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import { CrmFailure } from '../domain/errors'
import type { Clock, CrmRepository } from './ports'

type TaskServiceDependencies = {
  clock: Clock
  repository: CrmRepository
}

/**
 * Use-case orchestration for a deal's follow-up tasks: the next-step task list
 * that PRD 7.4 holds every open deal to, plus the critical-task view.
 *
 * It is a sibling of `CrmService` rather than more methods on it because tasks
 * are their own aggregate — created, completed, cancelled and rescheduled on
 * their own routes — while stage moves and the board stay deal-centric. Both
 * share one repository and clock, so Task 5's inbound path still records its
 * auto-task through the deal-create path on `CrmService` without touching this.
 *
 * Authorization is "authenticated" and nothing finer, matching `CrmService`:
 * PRD 3 gives the owner full access in the MVP and defers the manager role, so
 * the assignee is stored and filterable but is not yet a permission boundary.
 */
export class TaskService {
  constructor(private readonly dependencies: TaskServiceDependencies) {}

  async createTask(
    dealId: string,
    input: TaskCreateInput,
    actor: AuthenticatedPrincipal,
  ): Promise<DealTaskDto> {
    const task = await this.dependencies.repository.createTask({
      dealId,
      input,
      actorUserId: actor.id,
      now: this.now(),
    })
    if (!task) throw new CrmFailure('not_found', 'Сделка не найдена')
    return task
  }

  async updateTask(
    taskId: string,
    input: TaskUpdateInput,
    actor: AuthenticatedPrincipal,
  ): Promise<DealTaskDto> {
    const task = await this.dependencies.repository.updateTask({
      taskId,
      input,
      actorUserId: actor.id,
      now: this.now(),
    })
    if (!task) throw new CrmFailure('not_found', 'Задача не найдена')
    return task
  }

  listCriticalTasks(_actor: AuthenticatedPrincipal): Promise<CriticalTasksResponse> {
    return this.dependencies.repository.listCriticalTasks(this.now())
  }

  private now(): Date {
    return this.dependencies.clock.now()
  }
}
