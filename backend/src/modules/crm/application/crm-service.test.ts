import { beforeEach, describe, expect, test } from 'bun:test'
import type {
  ClientDetailDto,
  ClientLookupResponse,
  DealActivityDto,
  DealDetailDto,
  DealListPage,
} from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import { CrmFailure } from '../domain/errors'
import { CrmService } from './crm-service'
import type { CrmRepository, DealCreateCommand, DealUpdateCommand, NoteCommand } from './ports'

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
  createDeal: DealCreateCommand[]
  updateDeal: DealUpdateCommand[]
  addNote: NoteCommand[]
  lookupClientByPhone: Array<{ phoneNormalized: string; now: Date }>
  listDeals: Array<{ now: Date }>
}

function createRepository(overrides: Partial<CrmRepository> = {}) {
  const calls: RecordedCalls = {
    createDeal: [],
    updateDeal: [],
    addNote: [],
    lookupClientByPhone: [],
    listDeals: [],
  }
  const repository: CrmRepository = {
    listDeals: async (_query, at) => {
      calls.listDeals.push({ now: at })
      return { items: [], page: 1, pageSize: 20, total: 0, hasNext: false } as DealListPage
    },
    findDeal: async () => null,
    createDeal: async (command) => {
      calls.createDeal.push(command)
      return { id: 'deal' } as unknown as DealDetailDto
    },
    updateDeal: async (command) => {
      calls.updateDeal.push(command)
      return { id: 'deal' } as unknown as DealDetailDto
    },
    addNote: async (command) => {
      calls.addNote.push(command)
      return { id: 'activity' } as unknown as DealActivityDto
    },
    findClient: async () => null,
    lookupClientByPhone: async (phoneNormalized, at) => {
      calls.lookupClientByPhone.push({ phoneNormalized, now: at })
      return { client: null, openDeal: null } as ClientLookupResponse
    },
    ...overrides,
  }
  return { calls, repository }
}

function createService(overrides: Partial<CrmRepository> = {}) {
  const { calls, repository } = createRepository(overrides)
  return { calls, service: new CrmService({ repository, clock: { now: () => now } }) }
}

describe('phone identity', () => {
  /**
   * PRD 5: the normalized phone is the client's identity. The service resolves
   * it before persistence sees the payload, so no repository call can store a
   * second spelling of a client who already exists.
   */
  test('normalizes a formatted phone before the deal reaches persistence', async () => {
    const { calls, service } = createService()

    await service.createDeal(
      { name: 'Олександр', phone: '+38 (093) 533-53-53', source: 'teraso.com.ua' },
      actor,
    )

    expect(calls.createDeal[0]?.phoneNormalized).toBe('+380935335353')
  })

  test('normalizes the lookup phone so the duplicate warning matches stored clients', async () => {
    const { calls, service } = createService()

    await service.lookupClient({ phone: '0935335353' }, actor)

    expect(calls.lookupClientByPhone[0]?.phoneNormalized).toBe('+380935335353')
  })

  test('rejects an unusable phone without touching persistence', async () => {
    const { calls, service } = createService()

    await expect(
      service.createDeal({ name: 'Олександр', phone: '123', source: 'teraso.com.ua' }, actor),
    ).rejects.toThrow('Укажите корректный номер телефона')
    expect(calls.createDeal).toHaveLength(0)
  })
})

describe('actor and clock', () => {
  test('stamps the acting user as the author of every write', async () => {
    const { calls, service } = createService()

    await service.createDeal({ name: 'A', phone: '+380935335353', source: 's' }, actor)
    await service.updateDeal('deal-1', { currentNote: 'Перезвонить' }, actor)
    await service.addNote('deal-1', { text: 'Звонил, занят' }, actor)

    expect(calls.createDeal[0]?.actorUserId).toBe(actor.id)
    expect(calls.updateDeal[0]?.actorUserId).toBe(actor.id)
    expect(calls.addNote[0]?.actorUserId).toBe(actor.id)
  })

  test('reads urgency against the injected clock rather than the wall clock', async () => {
    const { calls, service } = createService()

    await service.listDeals(
      { page: 1, pageSize: 20, sort: 'submittedAt', direction: 'desc', noNextStep: false, overdue: false, dueToday: false, isCritical: false },
      actor,
    )

    expect(calls.listDeals[0]?.now).toBe(now)
  })
})

describe('missing records', () => {
  let service: CrmService

  beforeEach(() => {
    service = createService({
      findDeal: async () => null,
      updateDeal: async () => null,
      addNote: async () => null,
      findClient: async () => null,
    }).service
  })

  test('reports a missing deal as a not-found failure', async () => {
    for (const operation of [
      () => service.getDeal('11111111-1111-7111-8111-111111111111', actor),
      () => service.updateDeal('11111111-1111-7111-8111-111111111111', { currentNote: 'x' }, actor),
      () => service.addNote('11111111-1111-7111-8111-111111111111', { text: 'x' }, actor),
    ]) {
      const error = await operation().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(CrmFailure)
      expect((error as CrmFailure).kind).toBe('not_found')
    }
  })

  test('reports a missing client as a not-found failure', async () => {
    const error = await service
      .getClient('11111111-1111-7111-8111-111111111111', actor)
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrmFailure)
    expect((error as CrmFailure).kind).toBe('not_found')
  })

  test('returns an empty lookup instead of failing when nobody has that phone', async () => {
    const { service: lookupService } = createService()

    expect(await lookupService.lookupClient({ phone: '+380935335353' }, actor)).toEqual({
      client: null,
      openDeal: null,
    })
  })
})

describe('deal detail reads', () => {
  test('returns the stored deal when it exists', async () => {
    const deal = { id: 'deal-1' } as unknown as DealDetailDto
    const { service } = createService({ findDeal: async () => deal })

    expect(await service.getDeal('11111111-1111-7111-8111-111111111111', actor)).toBe(deal)
  })

  test('returns the stored client when it exists', async () => {
    const client = { id: 'client-1' } as unknown as ClientDetailDto
    const { service } = createService({ findClient: async () => client })

    expect(await service.getClient('11111111-1111-7111-8111-111111111111', actor)).toBe(client)
  })
})
