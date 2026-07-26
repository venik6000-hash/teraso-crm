import { beforeEach, describe, expect, test } from 'bun:test'
import type {
  ClientDetailDto,
  ClientLookupResponse,
  DealActivityDto,
  DealBoardResponse,
  DealDetailDto,
  DealListPage,
  DealTaskDto,
  InboundQuizLeadInput,
  InboundQuizLeadResult,
} from '@teraso-crm/contracts'

import type { AuthenticatedPrincipal } from '../../auth'
import { CrmFailure } from '../domain/errors'
import { CrmService } from './crm-service'
import type {
  CrmRepository,
  DealCreateCommand,
  DealStageChangeCommand,
  DealUpdateCommand,
  InboundQuizLeadCommand,
  LeadNotifier,
  NewLeadFact,
  NoteCommand,
} from './ports'

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
  changeStage: DealStageChangeCommand[]
  addNote: NoteCommand[]
  recordInboundQuizLead: InboundQuizLeadCommand[]
  lookupClientByPhone: Array<{ phoneNormalized: string; now: Date }>
  listDeals: Array<{ now: Date }>
  listBoard: Array<{ now: Date }>
}

function createRepository(overrides: Partial<CrmRepository> = {}) {
  const calls: RecordedCalls = {
    createDeal: [],
    updateDeal: [],
    changeStage: [],
    addNote: [],
    recordInboundQuizLead: [],
    lookupClientByPhone: [],
    listDeals: [],
    listBoard: [],
  }
  const repository: CrmRepository = {
    listDeals: async (_query, at) => {
      calls.listDeals.push({ now: at })
      return { items: [], page: 1, pageSize: 20, total: 0, hasNext: false } as DealListPage
    },
    listBoard: async (_query, at) => {
      calls.listBoard.push({ now: at })
      return { columns: [] } as DealBoardResponse
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
    changeStage: async (command) => {
      calls.changeStage.push(command)
      return { id: 'deal' } as unknown as DealDetailDto
    },
    addNote: async (command) => {
      calls.addNote.push(command)
      return { id: 'activity' } as unknown as DealActivityDto
    },
    createTask: async () => ({ id: 'task' }) as unknown as DealTaskDto,
    updateTask: async () => ({ id: 'task' }) as unknown as DealTaskDto,
    listCriticalTasks: async () => ({ items: [] }),
    findClient: async () => null,
    lookupClientByPhone: async (phoneNormalized, at) => {
      calls.lookupClientByPhone.push({ phoneNormalized, now: at })
      return { client: null, openDeal: null } as ClientLookupResponse
    },
    recordInboundQuizLead: async (command) => {
      calls.recordInboundQuizLead.push(command)
      return {
        status: 'created',
        clientId: '00000000-0000-7000-8000-0000000000c1',
        dealId: '00000000-0000-7000-8000-0000000000d1',
      }
    },
    ...overrides,
  }
  return { calls, repository }
}

function createService(overrides: Partial<CrmRepository> = {}, notifier?: LeadNotifier) {
  const { calls, repository } = createRepository(overrides)
  return {
    calls,
    service: new CrmService({ repository, clock: { now: () => now }, notifier }),
  }
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

describe('inbound quiz lead', () => {
  const lead: InboundQuizLeadInput = {
    externalId: 'lead_1',
    receivedAt: '2026-07-23T08:30:00.000Z',
    name: 'Олександр',
    phone: '+38 (093) 533-53-53',
    source: 'teraso.com.ua',
    form: 'Квіз',
    landingUrl: 'https://teraso.com.ua/kviz',
  }

  test('normalizes the phone and passes the arrival time and clock distinctly', async () => {
    const { calls, service } = createService()

    const result = await service.recordInboundQuizLead(lead)

    const command = calls.recordInboundQuizLead[0]
    expect(command?.phoneNormalized).toBe('+380935335353')
    // `receivedAt` is the payload's arrival time; `now` is the injected clock. The
    // service must keep them separate so the auto-task can anchor on the former.
    expect(command?.receivedAt.toISOString()).toBe('2026-07-23T08:30:00.000Z')
    expect(command?.now).toBe(now)
    expect(result.status).toBe('created')
  })

  test('rejects an unusable phone before persistence, like every other write', async () => {
    const { calls, service } = createService()

    await expect(service.recordInboundQuizLead({ ...lead, phone: '123' })).rejects.toThrow(
      'Укажите корректный номер телефона',
    )
    expect(calls.recordInboundQuizLead).toHaveLength(0)
  })

  /**
   * `receivedAt` is signed but, unlike `x-teraso-timestamp`, is not otherwise
   * constrained, and it drives the auto-task's due time. A far-future value would
   * produce a lead that never turns critical and so silently never surfaces — an
   * invisible failure, which is worse than a loud one.
   */
  test('bounds receivedAt tightly in the future and generously in the past', async () => {
    const { calls, service } = createService()
    const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString()

    // Tight forwards: only clock skew is legitimate.
    await expect(
      service.recordInboundQuizLead({ ...lead, receivedAt: at(2 * 60 * 60 * 1000) }),
    ).rejects.toThrow('Недопустимое время получения заявки')

    // Generous backwards, but not unbounded.
    await expect(
      service.recordInboundQuizLead({ ...lead, receivedAt: at(-30 * 24 * 60 * 60 * 1000) }),
    ).rejects.toThrow('Недопустимое время получения заявки')

    expect(calls.recordInboundQuizLead).toHaveLength(0)

    // A retry backlog after an outage, and the deliberately backdated e2e shape,
    // both stay inside the window.
    await service.recordInboundQuizLead({ ...lead, receivedAt: at(-2 * 60 * 60 * 1000) })
    await service.recordInboundQuizLead({ ...lead, receivedAt: at(-6 * 24 * 60 * 60 * 1000) })
    await service.recordInboundQuizLead({ ...lead, receivedAt: at(-30 * 60 * 1000) })
    expect(calls.recordInboundQuizLead).toHaveLength(3)
  })

  test('refuses a whitespace-only external id that would degenerate the idempotency key', async () => {
    const { calls, service } = createService()

    // The contract bounds externalId at 1..160 characters but does not trim it, so
    // " " passes the schema and would otherwise become a key shared by every such
    // delivery.
    await expect(service.recordInboundQuizLead({ ...lead, externalId: '   ' })).rejects.toThrow(
      'Не указан внешний идентификатор заявки',
    )
    expect(calls.recordInboundQuizLead).toHaveLength(0)
  })
})

describe('actor and clock', () => {
  test('stamps the acting user as the author of every write', async () => {
    const { calls, service } = createService()

    await service.createDeal({ name: 'A', phone: '+380935335353', source: 's' }, actor)
    await service.updateDeal('deal-1', { currentNote: 'Перезвонить' }, actor)
    await service.changeStage('deal-1', { stage: 'QUALIFIED' }, actor)
    await service.addNote('deal-1', { text: 'Звонил, занят' }, actor)

    expect(calls.createDeal[0]?.actorUserId).toBe(actor.id)
    expect(calls.updateDeal[0]?.actorUserId).toBe(actor.id)
    expect(calls.changeStage[0]?.actorUserId).toBe(actor.id)
    expect(calls.addNote[0]?.actorUserId).toBe(actor.id)
  })

  test('reads urgency against the injected clock rather than the wall clock', async () => {
    const { calls, service } = createService()

    await service.listDeals(
      { page: 1, pageSize: 20, sort: 'submittedAt', direction: 'desc', noNextStep: false, overdue: false, dueToday: false, isCritical: false },
      actor,
    )
    await service.getBoard(
      { noNextStep: false, overdue: false, dueToday: false, isCritical: false },
      actor,
    )

    expect(calls.listDeals[0]?.now).toBe(now)
    expect(calls.listBoard[0]?.now).toBe(now)
  })
})

describe('missing records', () => {
  let service: CrmService

  beforeEach(() => {
    service = createService({
      findDeal: async () => null,
      updateDeal: async () => null,
      changeStage: async () => null,
      addNote: async () => null,
      findClient: async () => null,
    }).service
  })

  test('reports a missing deal as a not-found failure', async () => {
    for (const operation of [
      () => service.getDeal('11111111-1111-7111-8111-111111111111', actor),
      () => service.updateDeal('11111111-1111-7111-8111-111111111111', { currentNote: 'x' }, actor),
      () => service.changeStage('11111111-1111-7111-8111-111111111111', { stage: 'QUALIFIED' }, actor),
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

/* ------------------------------------------------------------------ *
 * Announcing a committed lead (PRD 6.1, PRD 7.7)
 * ------------------------------------------------------------------ */

describe('new lead announcements', () => {
  const inbound: InboundQuizLeadInput = {
    externalId: 'quiz-1',
    source: 'teraso.com.ua',
    receivedAt: '2026-07-23T09:59:00.000Z',
    name: 'Олександр',
    phone: '+380935335353',
    form: 'Квіз',
    landingUrl: 'https://teraso.com.ua/quiz',
  }

  function createAnnouncingService(status: InboundQuizLeadResult['status']) {
    const announced: NewLeadFact[] = []
    const { service } = createService(
      {
        recordInboundQuizLead: async () => ({
          status,
          clientId: '00000000-0000-7000-8000-0000000000c1',
          dealId: '00000000-0000-7000-8000-0000000000d1',
        }),
      },
      { async newLeadRecorded(fact) { announced.push(fact) } },
    )
    return { announced, service }
  }

  /**
   * The status, not the HTTP code, decides. Both `attached-to-open-deal` and the
   * two genuinely-new statuses answer 201, so branching on the response code
   * would announce a "new lead" for a deal that already existed and was merely
   * appended to.
   */
  test('announces exactly the two statuses that really created a lead', async () => {
    for (const status of ['created', 'new-deal-for-existing-client'] as const) {
      const { announced, service } = createAnnouncingService(status)
      await service.recordInboundQuizLead(inbound)

      expect(announced).toEqual([
        {
          dealId: '00000000-0000-7000-8000-0000000000d1',
          clientId: '00000000-0000-7000-8000-0000000000c1',
          clientName: 'Олександр',
          source: 'teraso.com.ua',
        },
      ])
    }
  })

  test('stays silent for a redelivery and for a submission on an existing open deal', async () => {
    for (const status of ['duplicate-delivery', 'attached-to-open-deal'] as const) {
      const { announced, service } = createAnnouncingService(status)
      await service.recordInboundQuizLead(inbound)

      expect(`${status} -> ${announced.length}`).toBe(`${status} -> 0`)
    }
  })

  /**
   * The lead is already committed by the time the announcement runs, so a broken
   * notification path must not turn a stored lead into a 500 the site will retry
   * forever. The recurring dispatcher still catches the deal 30 minutes later.
   */
  test('still reports the stored lead when the announcement itself fails', async () => {
    const { service } = createService(
      {
        recordInboundQuizLead: async () => ({
          status: 'created',
          clientId: '00000000-0000-7000-8000-0000000000c1',
          dealId: '00000000-0000-7000-8000-0000000000d1',
        }),
      },
      {
        async newLeadRecorded() {
          throw new Error('notification store is unavailable')
        },
      },
    )

    expect(await service.recordInboundQuizLead(inbound)).toEqual({
      status: 'created',
      clientId: '00000000-0000-7000-8000-0000000000c1',
      dealId: '00000000-0000-7000-8000-0000000000d1',
    })
  })

  test('never announces a lead the repository refused to record', async () => {
    const announced: NewLeadFact[] = []
    const { service } = createService(
      {
        recordInboundQuizLead: async () => {
          throw new CrmFailure('validation', 'Недопустимое время получения заявки')
        },
      },
      { async newLeadRecorded(fact) { announced.push(fact) } },
    )

    await expect(service.recordInboundQuizLead(inbound)).rejects.toBeInstanceOf(CrmFailure)
    expect(announced).toHaveLength(0)
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
