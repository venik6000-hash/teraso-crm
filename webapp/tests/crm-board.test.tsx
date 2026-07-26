import { expect, test } from 'bun:test'
import {
  ACTIVE_DEAL_STAGES,
  type DealBoardResponse,
  type DealDetailDto,
  type DealSummaryDto,
  type DealTaskDto,
} from '@teraso-crm/contracts'

import { DealBoard } from '../src/features/crm/components/DealBoard'
import { TaskQueue } from '../src/features/crm/components/TaskQueue'
import {
  DEAL_STAGE_LABELS,
  boardDropIntent,
  buildTaskInput,
  shouldPromptNextStep,
} from '../src/features/crm/model'
import { renderInRouter } from './render-in-router'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const TASK_ID = '99999999-9999-4999-8999-999999999999'
const USER_ID = '55555555-5555-4555-8555-555555555555'

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
    responsibleUserId: USER_ID,
    responsibleName: 'owner@teraso.com.ua',
    nearestActiveTask: null,
    isCritical: false,
    noNextStep: false,
    hasOverdueTask: false,
    createdAt: '2026-07-20T08:30:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<DealTaskDto> = {}): DealTaskDto {
  return {
    id: TASK_ID,
    dealId: DEAL_ID,
    kind: 'CALL',
    title: 'Перезвонить по замеру',
    dueAt: '2026-07-21T09:00:00.000Z',
    status: 'ACTIVE',
    assigneeUserId: USER_ID,
    assigneeName: 'owner@teraso.com.ua',
    completedAt: null,
    createdAt: '2026-07-20T09:00:00.000Z',
    ...overrides,
  }
}

function board(deals: ReadonlyArray<DealSummaryDto>): DealBoardResponse {
  return {
    columns: ACTIVE_DEAL_STAGES.map((stage) => {
      const forStage = deals.filter((deal) => deal.stage === stage)
      return { stage, totalCount: forStage.length, deals: forStage }
    }),
  }
}

/* ------------------------------------------------------------------ *
 * Drop intent (PRD 7.3, 7.6)
 * ------------------------------------------------------------------ */

/**
 * Dropping a card decides which confirmation to open, never whether the move is
 * legal: the reachable-stage graph is server-authoritative and mirroring it here
 * is exactly how the browser would drift from it.
 */
test('a drop onto a paid stage asks for the payment before committing', () => {
  expect(boardDropIntent('PROPOSAL_SENT', 'PREPAYMENT')).toEqual({
    kind: 'payment',
    stage: 'PREPAYMENT',
  })
  expect(boardDropIntent('PREPAYMENT', 'WON')).toEqual({ kind: 'payment', stage: 'WON' })
})

test('a drop onto the loss zone asks for a reason', () => {
  expect(boardDropIntent('NEW', 'LOST')).toEqual({ kind: 'loss' })
})

test('an ordinary drop commits directly and a drop on the same column does nothing', () => {
  expect(boardDropIntent('NEW', 'QUALIFIED')).toEqual({ kind: 'stage', stage: 'QUALIFIED' })
  expect(boardDropIntent('NEW', 'NEW')).toEqual({ kind: 'ignored' })
})

/**
 * A backwards drop is offered to the server rather than refused here. The server
 * answers «Недопустимый переход воронки», which the board surfaces while the
 * card stays where it was — one authority for the funnel instead of two.
 */
test('offers even an illegal move to the server instead of judging it locally', () => {
  expect(boardDropIntent('WON', 'QUALIFIED')).toEqual({ kind: 'stage', stage: 'QUALIFIED' })
})

/* ------------------------------------------------------------------ *
 * Board rendering
 * ------------------------------------------------------------------ */

test('renders one column per active stage and never a column for lost deals', async () => {
  const html = await renderInRouter(<DealBoard board={board([summary()])} />, '/app/board')

  for (const stage of ACTIVE_DEAL_STAGES) {
    expect(html).toContain(DEAL_STAGE_LABELS[stage])
  }
  // LOST is a drop target below the columns, not a column of its own (PRD 7.3).
  expect(html).toContain('Потеряна')
})

test('marks a critical card with words, not colour alone', async () => {
  const html = await renderInRouter(
    <DealBoard
      board={board([summary({ isCritical: true, hasOverdueTask: true, noNextStep: true })])}
    />,
    '/app/board',
  )

  expect(html).toContain('Требует действия')
  expect(html).toContain('просроченная задача')
})

test('shows the card fields PRD 7.6 requires', async () => {
  const html = await renderInRouter(
    <DealBoard board={board([summary({ nearestActiveTask: task() })])} />,
    '/app/board',
  )

  expect(html).toContain('Олена Ковальчук')
  expect(html).toContain('quiz')
  expect(html).toContain('Класс B')
  expect(html).toContain('65 000')
  expect(html).toContain('Звонок')
})

/**
 * The rollback guarantee. Columns are rendered straight from the server
 * response and the board keeps no optimistic copy, so a card only appears in
 * its new column once the server has accepted the move — and a cancelled
 * dialog or a rejected request needs no undo path at all.
 */
test('keeps a card in its served column while a move is still pending', async () => {
  const html = await renderInRouter(
    <DealBoard
      board={board([summary()])}
      pendingMove={{ dealId: DEAL_ID, stage: 'PREPAYMENT' }}
    />,
    '/app/board',
  )

  const newColumn = html.indexOf(DEAL_STAGE_LABELS.NEW)
  const prepaymentColumn = html.indexOf(DEAL_STAGE_LABELS.PREPAYMENT)
  const card = html.indexOf('Олена Ковальчук')

  expect(card).toBeGreaterThan(newColumn)
  expect(card).toBeLessThan(prepaymentColumn)
})

test('states an empty column instead of rendering a blank area', async () => {
  const html = await renderInRouter(<DealBoard board={board([])} />, '/app/board')
  expect(html).toContain('Пусто')
})

/* ------------------------------------------------------------------ *
 * Task form (PRD 7.4)
 * ------------------------------------------------------------------ */

test('requires a type, an exact time and a text before a task can be saved', () => {
  const missing = buildTaskInput({ kind: 'CALL', title: '', dueAtInput: '' })
  expect(missing.ok).toBe(false)
  if (!missing.ok) {
    expect(missing.errors.fields.title).toBe('Заполните поле')
    expect(missing.errors.fields.dueAt).toBe('Укажите дату и время')
  }

  const noTime = buildTaskInput({ kind: 'CALL', title: 'Перезвонить', dueAtInput: '' })
  expect(noTime.ok).toBe(false)
  if (!noTime.ok) expect(noTime.errors.fields.dueAt).toBe('Укажите дату и время')
})

/** The input speaks Kyiv wall-clock time; the API takes a UTC instant (PRD 10). */
test('converts the Kyiv time the owner typed into a UTC instant', () => {
  const built = buildTaskInput({
    kind: 'MESSAGE',
    title: 'Написать в Telegram',
    dueAtInput: '2026-07-21T12:00',
    assigneeUserId: USER_ID,
  })

  expect(built.ok).toBe(true)
  if (built.ok) {
    // Kyiv is UTC+3 in July.
    expect(built.value.dueAt).toBe('2026-07-21T09:00:00.000Z')
    expect(built.value.assigneeUserId).toBe(USER_ID)
  }
})

/* ------------------------------------------------------------------ *
 * Next-step prompt (PRD 7.4)
 * ------------------------------------------------------------------ */

function detail(overrides: Partial<DealDetailDto> = {}): DealDetailDto {
  return {
    ...summary(),
    landingUrl: null,
    material: null,
    areaLabel: null,
    budgetLabel: null,
    objectType: null,
    needTiming: null,
    preferredChannel: null,
    prepaymentAmount: null,
    prepaymentPaidAt: null,
    fullPaymentAmount: null,
    fullPaymentPaidAt: null,
    currentNote: null,
    updatedAt: '2026-07-20T09:00:00.000Z',
    tasks: [],
    activities: [],
    hasMoreTasks: false,
    hasMoreActivities: false,
    attribution: null,
    ...overrides,
  }
}

/**
 * Completing a task does not satisfy the next-step rule — the deal still needs a
 * future one (PRD 7.4). The prompt is a UI convenience built from the deal's
 * own task list; the authoritative `noNextStep` flag still comes from the server
 * on the next read.
 */
test('prompts for a next step when the last active task on an open deal is completed', () => {
  expect(shouldPromptNextStep(detail({ tasks: [task()] }), TASK_ID)).toBe(true)
})

test('stays quiet when another active task remains', () => {
  const second = task({ id: '88888888-8888-4888-8888-888888888888' })
  expect(shouldPromptNextStep(detail({ tasks: [task(), second] }), TASK_ID)).toBe(false)
})

test('stays quiet on a closed deal, which is exempt from the next-step rule', () => {
  expect(shouldPromptNextStep(detail({ stage: 'WON', tasks: [task()] }), TASK_ID)).toBe(false)
  expect(shouldPromptNextStep(detail({ stage: 'LOST', tasks: [task()] }), TASK_ID)).toBe(false)
})

/* ------------------------------------------------------------------ *
 * Task queue
 * ------------------------------------------------------------------ */

test('groups the critical queue and names why each deal is in it', async () => {
  const html = await renderInRouter(
    <TaskQueue
      items={[
        {
          task: task({ dueAt: '2026-07-19T09:00:00.000Z' }),
          deal: summary({ isCritical: true, hasOverdueTask: true }),
        },
      ]}
    />,
    '/app/tasks',
  )

  expect(html).toContain('Олена Ковальчук')
  expect(html).toContain('Перезвонить по замеру')
  expect(html).toContain('Требует действия')
})

test('states an empty queue as good news rather than as an error', async () => {
  const html = await renderInRouter(<TaskQueue items={[]} />, '/app/tasks')
  expect(html).toContain('Просроченных задач нет')
})
