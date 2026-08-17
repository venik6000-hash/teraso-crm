import { describe, expect, test } from 'bun:test'
import type { CriticalTasksResponse, DealTaskDto } from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import { CrmFailure } from '../domain/errors'
import type { CrmRepository, TaskCreateCommand, TaskUpdateCommand } from './ports'
import { TaskService } from './task-service'

const actor: AuthenticatedPrincipal = {
  id: '00000000-0000-7000-8000-000000000001',
  email: 'owner@teraso.com.ua',
  displayName: 'Руководитель',
  role: 'admin',
  createdAt: '2026-07-01T00:00:00.000Z',
  sessionId: '00000000-0000-7000-8000-0000000000ff',
}

const now = new Date('2026-07-23T10:00:00.000Z')

type RecordedCalls = {
  createTask: TaskCreateCommand[]
  updateTask: TaskUpdateCommand[]
  listCriticalTasks: Array<{ now: Date }>
}

/**
 * TaskService only owns the repository ports it needs, but the port type is the
 * whole CrmRepository, so the unused reads are stubbed to throw: a task path that
 * reached for a deal read would fail loudly rather than pass on an empty stub.
 */
function createService(overrides: Partial<CrmRepository> = {}) {
  const calls: RecordedCalls = { createTask: [], updateTask: [], listCriticalTasks: [] }
  const unused = () => {
    throw new Error('unexpected repository call')
  }
  const repository = {
    listDeals: unused,
    listBoard: unused,
    findDeal: unused,
    createDeal: unused,
    updateDeal: unused,
    changeStage: unused,
    addNote: unused,
    findClient: unused,
    lookupClientByPhone: unused,
    createTask: async (command: TaskCreateCommand) => {
      calls.createTask.push(command)
      return { id: 'task' } as unknown as DealTaskDto
    },
    updateTask: async (command: TaskUpdateCommand) => {
      calls.updateTask.push(command)
      return { id: 'task' } as unknown as DealTaskDto
    },
    listCriticalTasks: async (at: Date) => {
      calls.listCriticalTasks.push({ now: at })
      return { items: [], hasMore: false } satisfies CriticalTasksResponse
    },
    ...overrides,
  } as CrmRepository
  return { calls, service: new TaskService({ repository, clock: { now: () => now } }) }
}

describe('task creation and updates', () => {
  test('stamps the acting user and the clock on a created task', async () => {
    const { calls, service } = createService()

    await service.createTask(
      'deal-1',
      { kind: 'CALL', title: 'Позвонить', dueAt: '2026-07-23T12:00:00.000Z' },
      actor,
    )

    expect(calls.createTask[0]?.actorUserId).toBe(actor.id)
    expect(calls.createTask[0]?.now).toBe(now)
  })

  test('stamps the acting user and the clock on a task update', async () => {
    const { calls, service } = createService()

    await service.updateTask('task-1', { status: 'COMPLETED' }, actor)

    expect(calls.updateTask[0]?.actorUserId).toBe(actor.id)
    expect(calls.updateTask[0]?.now).toBe(now)
  })

  test('reads critical tasks against the injected clock', async () => {
    const { calls, service } = createService()

    await service.listCriticalTasks(actor)

    expect(calls.listCriticalTasks[0]?.now).toBe(now)
  })
})

describe('missing records', () => {
  test('reports a missing deal when creating a task as not-found', async () => {
    const { service } = createService({ createTask: async () => null })

    const error = await service
      .createTask('deal-1', { kind: 'CALL', title: 'x', dueAt: '2026-07-23T12:00:00.000Z' }, actor)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrmFailure)
    expect((error as CrmFailure).kind).toBe('not_found')
    expect((error as CrmFailure).message).toBe('Сделка не найдена')
  })

  test('reports a missing task on update as not-found', async () => {
    const { service } = createService({ updateTask: async () => null })

    const error = await service
      .updateTask('task-1', { status: 'CANCELLED' }, actor)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrmFailure)
    expect((error as CrmFailure).kind).toBe('not_found')
    expect((error as CrmFailure).message).toBe('Задача не найдена')
  })
})
