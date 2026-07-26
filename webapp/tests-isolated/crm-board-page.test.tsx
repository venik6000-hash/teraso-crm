import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  ACTIVE_DEAL_STAGES,
  type DealBoardResponse,
  type DealStageChangeInput,
  type DealSummaryDto,
} from '@teraso-crm/contracts'


/**
 * The board page's handler wiring.
 *
 * The component tests next door cover `boardDropIntent` as a pure function and
 * `DealBoard` as a renderer, but neither reaches the path that turns a drop into
 * a request — which is where the deal id is resolved. That gap is what let a
 * plain stage drop post to an empty id: the mutation was keyed on the dialog
 * state a plain drop deliberately never sets, so the request went to
 * `/api/crm/deals//stage` and came back as an English 404 on a Russian screen.
 *
 * No DnD is simulated here on purpose. `DealBoard` is stubbed and its `onDrop`
 * captured, so this exercises the wiring rather than dnd-kit's event plumbing.
 *
 * It lives outside `tests/` and runs in its own process because Bun's module
 * mocks are process-wide: a stub installed here would otherwise follow the
 * runner into every other file, and `mock.restore()` does not undo a
 * `mock.module`.
 */

const DEAL_ID = '11111111-1111-4111-8111-111111111111'

type StageCall = { hookDealId: string | undefined; argument: unknown }

const stageCalls: StageCall[] = []
let capturedOnDrop: ((deal: DealSummaryDto, intent: unknown) => void) | null = null

function summary(overrides: Partial<DealSummaryDto> = {}): DealSummaryDto {
  return {
    id: DEAL_ID,
    client: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Олена Ковальчук',
      phoneNormalized: '+380671234567',
      createdAt: '2026-07-01T09:00:00.000Z',
    },
    stage: 'NEW',
    leadClass: 'B',
    lossReason: null,
    source: 'quiz',
    form: 'Квіз',
    submittedAt: '2026-07-20T08:30:00.000Z',
    potentialAmount: '65000.00',
    responsibleUserId: null,
    responsibleName: null,
    nearestActiveTask: null,
    isCritical: false,
    noNextStep: false,
    hasOverdueTask: false,
    createdAt: '2026-07-20T08:30:00.000Z',
    ...overrides,
  }
}

const board: DealBoardResponse = {
  columns: ACTIVE_DEAL_STAGES.map((stage) => ({
    stage,
    totalCount: stage === 'NEW' ? 1 : 0,
    deals: stage === 'NEW' ? [summary()] : [],
  })),
}

/**
 * Where the request would actually be addressed.
 *
 * Both spellings are read because the id can reach the API through either the
 * hook's argument or the mutation payload; taking whichever is present is what
 * the running code effectively does, so this asserts the destination rather
 * than a particular signature.
 */
function targetedDealId(call: StageCall): string | undefined {
  const argument = call.argument as { dealId?: string } | undefined
  return argument?.dealId ?? call.hookDealId
}

function idleMutation() {
  return { mutate: () => {}, mutateAsync: async () => {}, isPending: false, isError: false, error: null }
}

function stageOf(call: StageCall): string | undefined {
  const argument = call.argument as
    | { input?: DealStageChangeInput; stage?: string }
    | undefined
  return argument?.input?.stage ?? argument?.stage
}

beforeEach(() => {
  stageCalls.length = 0
  capturedOnDrop = null

  mock.module('../src/features/crm/components/DealBoard', () => ({
    DealBoard: (props: { onDrop?: (deal: DealSummaryDto, intent: unknown) => void }) => {
      capturedOnDrop = props.onDrop ?? null
      return null
    },
  }))
  mock.module('../src/features/crm/components/CommandSearch', () => ({
    CommandSearch: () => null,
  }))
  mock.module('@/features/notifications', () => ({
    NotificationBell: () => null,
    NotificationCenter: () => null,
    NotificationInbox: () => null,
    PushPermissionCard: () => null,
    toRussianTransportMessage: (error: unknown) =>
      error instanceof Error ? error.message : 'Не удалось выполнить запрос.',
    useNotificationInboxQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useMarkNotificationsReadMutation: () => ({ mutate: () => {}, isPending: false }),
    usePushSubscription: () => ({
      permission: 'default',
      isPending: false,
      error: null,
      enable: () => {},
    }),
  }))
  mock.module('../src/features/crm/queries', () => ({
    crmQueryKeys: {},
    crmInvalidatedRoots: [],
    useDealBoardQuery: () => ({ data: board, isPending: false, isError: false }),
    useDealListQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useDealQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useDashboardQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useCriticalTasksQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useClientLookupQuery: () => ({ data: undefined, isPending: false, isError: false }),
    useCreateDealMutation: () => idleMutation(),
    useUpdateDealMutation: () => idleMutation(),
    useAddDealNoteMutation: () => idleMutation(),
    useCreateTaskMutation: () => idleMutation(),
    useUpdateTaskMutation: () => idleMutation(),
    useChangeDealStageMutation: (hookDealId?: string) => ({
      mutate: (argument: unknown) => stageCalls.push({ hookDealId, argument }),
      isPending: false,
      isError: false,
      error: null,
    }),
  }))
})

afterEach(() => {
  mock.restore()
})

async function renderBoard() {
  const { renderInRouter } = await import('../tests/render-in-router')
  const { BoardPage } = await import('../src/features/crm/pages')

  await renderInRouter(<BoardPage search={{}} />, '/app/board')
  if (!capturedOnDrop) throw new Error('DealBoard was rendered without an onDrop handler')
  return capturedOnDrop
}

/**
 * The regression. A drop onto a stage that needs no confirmation has to reach
 * the API addressed at the dragged deal — these are the two most common board
 * moves, `NEW -> QUALIFIED` and `QUALIFIED -> PROPOSAL_SENT`.
 */
test('a plain stage drop targets the dragged deal', async () => {
  const onDrop = await renderBoard()

  onDrop(summary(), { kind: 'stage', stage: 'QUALIFIED' })

  expect(stageCalls).toHaveLength(1)
  expect(targetedDealId(stageCalls[0]!)).toBe(DEAL_ID)
  expect(stageOf(stageCalls[0]!)).toBe('QUALIFIED')
})

/** Reopening a closed deal goes through the same confirmation-free path. */
test('a reopen drop targets the dragged deal', async () => {
  const onDrop = await renderBoard()

  onDrop(summary({ stage: 'WON' }), { kind: 'stage', stage: 'NEW' })

  expect(stageCalls).toHaveLength(1)
  expect(targetedDealId(stageCalls[0]!)).toBe(DEAL_ID)
})

/**
 * The paid stages and the loss zone must NOT commit on the drop itself: the
 * contract refuses them without a payment or a reason, so the confirmation is
 * what carries those fields.
 */
test('a drop needing confirmation does not commit on its own', async () => {
  const onDrop = await renderBoard()

  onDrop(summary({ stage: 'PROPOSAL_SENT' }), { kind: 'payment', stage: 'PREPAYMENT' })
  onDrop(summary({ stage: 'PREPAYMENT' }), { kind: 'payment', stage: 'WON' })
  onDrop(summary(), { kind: 'loss' })

  expect(stageCalls).toHaveLength(0)
})

test('a drop onto the deal own column does nothing', async () => {
  const onDrop = await renderBoard()

  onDrop(summary(), { kind: 'ignored' })

  expect(stageCalls).toHaveLength(0)
})
