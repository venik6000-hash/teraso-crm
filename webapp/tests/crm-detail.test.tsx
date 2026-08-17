import { expect, test } from 'bun:test'
import {
  DEAL_DETAIL_ACTIVITY_LIMIT,
  dealCreateSchema,
  dealPath,
} from '@teraso-crm/contracts'
import type {
  ClientSummaryDto,
  DealActivityDto,
  DealDetailDto,
  DealSummaryDto,
  DealTaskDto,
} from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { ActivityTimeline } from '../src/features/crm/components/ActivityTimeline'
import { ContactActions } from '../src/features/crm/components/ContactActions'
import { DealDetail } from '../src/features/crm/components/DealDetail'
import { DealForm } from '../src/features/crm/components/DealForm'
import { TaskActions } from '../src/features/crm/components/TaskActions'
import {
  NOT_SET,
  assignableUserOptions,
  buildDealCreateInput,
  buildDealUpdateInput,
  contactLinks,
  personLabel,
  recordedPaymentAmount,
  safeExternalHref,
  toDealEditDraft,
  type DealFormDraft,
} from '../src/features/crm/model'
import { phoneFieldError, toFormErrors } from '../src/features/crm/validation'
import { renderInRouter } from './render-in-router'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_DEAL_ID = '66666666-6666-4666-8666-666666666666'
const CLIENT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_USER_ID = '77777777-7777-4777-8777-777777777777'
const TASK_ID = '99999999-9999-4999-8999-999999999999'

/**
 * The least a manual deal needs: the three required fields typed, every optional
 * select left on its «не задано» sentinel and no initial task. Each case below
 * overrides only what it is about.
 */
function minimalDealDraft(): DealFormDraft {
  return {
    name: 'Олена Ковальчук',
    phone: '+380671234567',
    source: 'Звонок',
    form: '',
    landingUrl: '',
    submittedAt: '',
    leadClass: NOT_SET,
    responsibleUserId: NOT_SET,
    material: NOT_SET,
    areaLabel: '',
    budgetLabel: '',
    objectType: '',
    needTiming: '',
    preferredChannel: NOT_SET,
    potentialAmount: '',
    currentNote: '',
    withTask: false,
    taskKind: 'CALL',
    taskTitle: '',
    taskDueAt: '',
  }
}

function client(): ClientSummaryDto {
  return {
    id: CLIENT_ID,
    name: 'Олена Ковальчук',
    phoneNormalized: '+380671234567',
    createdAt: '2026-07-01T09:00:00.000Z',
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

function summary(overrides: Partial<DealSummaryDto> = {}): DealSummaryDto {
  return {
    id: DEAL_ID,
    client: client(),
    stage: 'NEW',
    leadClass: 'A',
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

function activity(overrides: Partial<DealActivityDto> = {}): DealActivityDto {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    dealId: DEAL_ID,
    kind: 'NOTE_ADDED',
    text: 'Договорились о замере',
    fromStage: null,
    toStage: null,
    authorUserId: USER_ID,
    authorName: 'owner@teraso.com.ua',
    metadata: null,
    createdAt: '2026-07-20T11:00:00.000Z',
    ...overrides,
  }
}

function detail(overrides: Partial<DealDetailDto> = {}): DealDetailDto {
  return {
    ...summary(),
    landingUrl: 'https://teraso.com.ua/quiz',
    material: 'WPC',
    areaLabel: '40-60 м²',
    budgetLabel: 'до 100 000 ₴',
    objectType: 'Тераса',
    needTiming: 'Этот месяц',
    preferredChannel: 'TELEGRAM',
    prepaymentAmount: null,
    prepaymentPaidAt: null,
    fullPaymentAmount: null,
    fullPaymentPaidAt: null,
    currentNote: 'Ждёт замер',
    updatedAt: '2026-07-20T10:00:00.000Z',
    tasks: [],
    activities: [activity()],
    hasMoreTasks: false,
    hasMoreActivities: false,
    attribution: null,
    ...overrides,
  }
}

const noop = () => undefined
const asyncNoop = async () => undefined

/* ------------------------------------------------------------------ *
 * Validation feedback is Russian, including Zod's structural messages
 * ------------------------------------------------------------------ */

test('an empty manual deal reports missing fields in Russian, not in Zod English', () => {
  const parsed = dealCreateSchema.safeParse({})
  expect(parsed.success).toBe(false)

  const errors = toFormErrors(parsed.error!.issues)

  expect(errors.fields.name).toBe('Заполните поле')
  expect(errors.fields.phone).toBe('Заполните поле')
  expect(errors.fields.source).toBe('Заполните поле')
  expect(errors.formMessage).toBeNull()
  for (const message of Object.values(errors.fields)) {
    expect(message).not.toContain('Invalid input')
    expect(message).toMatch(/[А-Яа-яЁё]/)
  }
})

test('structural Zod failures are translated while contract messages stay as authored', () => {
  const tooLong = dealCreateSchema.safeParse({
    name: 'и'.repeat(200),
    phone: '+380671234567',
    source: 'quiz',
  })
  const badDate = dealCreateSchema.safeParse({
    name: 'Олена',
    phone: '+380671234567',
    source: 'quiz',
    submittedAt: 'вчера',
  })
  const badAmount = dealCreateSchema.safeParse({
    name: 'Олена',
    phone: '+380671234567',
    source: 'quiz',
    potentialAmount: '65 000 грн',
  })

  expect(toFormErrors(tooLong.error!.issues).fields.name).toBe(
    'Слишком длинное значение: не больше 120 символов',
  )
  expect(toFormErrors(badDate.error!.issues).fields.submittedAt).toBe('Укажите дату и время')
  expect(toFormErrors(badAmount.error!.issues).fields.potentialAmount).toBe(
    'Укажите сумму в формате 65000.00',
  )
})

test('a nested failure is reported both at the exact field and at its group', () => {
  const badTask = dealCreateSchema.safeParse({
    name: 'Олена',
    phone: '+380671234567',
    source: 'quiz',
    initialTask: { kind: 'CALL', title: 'Перезвонить', dueAt: 'завтра' },
  })

  const errors = toFormErrors(badTask.error!.issues)
  expect(errors.fields['initialTask.dueAt']).toBe('Укажите дату и время')
  expect(errors.fields.initialTask).toBe('Укажите дату и время')
})

test('a failure with no field is surfaced separately so a form cannot drop it', () => {
  const unknownField = dealCreateSchema.safeParse({
    name: 'Олена',
    phone: '+380671234567',
    source: 'quiz',
    nonsense: true,
  })

  const errors = toFormErrors(unknownField.error!.issues)
  expect(errors.formMessage).toBe('Недопустимое поле')
  expect(Object.keys(errors.fields)).toEqual([])
})

test('the phone field is checked as it is typed', () => {
  expect(phoneFieldError('')).toBe('Заполните поле')
  expect(phoneFieldError('+38067')).toBe('Слишком короткий номер')
  expect(phoneFieldError('+380671234567')).toBeNull()
  expect(phoneFieldError('0671234567')).toBeNull()
})

/* ------------------------------------------------------------------ *
 * Duplicate-phone warning
 * ------------------------------------------------------------------ */

test('a matching phone warns about the existing client without blocking the form', async () => {
  const warned = await renderInRouter(
    <DealForm
      existingClient={{ client: client(), openDeal: summary({ id: OTHER_DEAL_ID }) }}
      isPending={false}
      onCancel={noop}
      onSubmit={noop}
      submitError={null}
    />,
  )
  const submitting = await renderInRouter(
    <DealForm
      existingClient={{ client: client(), openDeal: summary({ id: OTHER_DEAL_ID }) }}
      isPending
      onCancel={noop}
      onSubmit={noop}
      submitError={null}
    />,
  )

  expect(warned).toContain('Клиент с этим номером уже есть')
  expect(warned).toContain('Олена Ковальчук')
  expect(warned).toContain(`href="${dealPath(OTHER_DEAL_ID)}"`)
  // The warning informs, it does not block. The differential against the
  // pending render is what makes this meaningful: `disabled` on its own also
  // appears inside Tailwind variant class names.
  expect(warned).not.toContain('disabled=""')
  expect(submitting).toContain('disabled=""')
})

test('an unknown phone shows no duplicate warning', async () => {
  const markup = await renderInRouter(
    <DealForm
      existingClient={{ client: null, openDeal: null }}
      isPending={false}
      onCancel={noop}
      onSubmit={noop}
      submitError={null}
    />,
  )

  expect(markup).not.toContain('Клиент с этим номером уже есть')
})

/* ------------------------------------------------------------------ *
 * Responsible user (PRD 7.1)
 *
 * The picker itself is a Radix `Select`: its options live in a portal and its
 * trigger renders no value without a DOM, so the payload rules are pinned on the
 * builders below and the render checks that the control and its stated default
 * reach the form at all.
 * ------------------------------------------------------------------ */

test('the manual form offers a responsible and says the default is the current user', async () => {
  const markup = await renderInRouter(
    <DealForm
      assignableUsers={[{ id: USER_ID, name: 'Руководитель' }]}
      currentUserId={USER_ID}
      existingClient={undefined}
      isPending={false}
      onCancel={noop}
      onSubmit={noop}
      submitError={null}
    />,
  )

  expect(markup).toContain('Ответственный')
  expect(markup).toContain('По умолчанию — вы')
})

test('the create payload carries the chosen responsible and hands the first task to them', () => {
  const built = buildDealCreateInput({
    ...minimalDealDraft(),
    responsibleUserId: USER_ID,
    withTask: true,
    taskTitle: 'Позвонить и уточнить площадь',
    taskDueAt: '2026-07-25T10:00',
  })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  expect(built.value.responsibleUserId).toBe(USER_ID)
  /**
   * The assignee is stated rather than left to the server, which is the rule
   * `taskCreateSchema.assigneeUserId` documents and the task dialog already
   * follows. Before this, the same first task was assigned when created from the
   * card and unassigned when created from this form.
   */
  expect(built.value.initialTask?.assigneeUserId).toBe(USER_ID)
})

test('an unassigned deal sends no responsible and no assignee at all', () => {
  const built = buildDealCreateInput({
    ...minimalDealDraft(),
    responsibleUserId: NOT_SET,
    withTask: true,
    taskTitle: 'Позвонить',
    taskDueAt: '2026-07-25T10:00',
  })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  // Absent, not null: a create has nothing to clear, so `dealCreateSchema` never
  // accepts a null here and the sentinel must not travel either.
  expect('responsibleUserId' in built.value).toBe(false)
  expect(built.value.initialTask && 'assigneeUserId' in built.value.initialTask).toBe(false)
  expect(JSON.stringify(built.value)).not.toContain(NOT_SET)
})

/**
 * The absent-versus-null rule of the edit dialog, which is where getting it wrong
 * is silent: `dealUpdateSchema` reads an omitted key as "leave it alone" and an
 * explicit `null` as "clear it", and the repository honours exactly that.
 */
test('the edit dialog clears the responsible with an explicit null and leaves the rest absent', () => {
  const initial = toDealEditDraft(detail({ responsibleUserId: USER_ID }))
  const built = buildDealUpdateInput(initial, { ...initial, responsibleUserId: NOT_SET })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  expect(built.value).toEqual({ responsibleUserId: null })
  // Every untouched field stays out of the PATCH; sending the draft wholesale
  // would overwrite each of them with whatever the dialog happened to show.
  expect(Object.keys(built.value)).toEqual(['responsibleUserId'])
})

test('the edit dialog reassigns without touching a single other field', () => {
  const initial = toDealEditDraft(detail({ responsibleUserId: USER_ID }))
  const built = buildDealUpdateInput(initial, { ...initial, responsibleUserId: OTHER_USER_ID })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  expect(built.value).toEqual({ responsibleUserId: OTHER_USER_ID })
})

test('an edit of another field never mentions the responsible', () => {
  const initial = toDealEditDraft(detail({ responsibleUserId: USER_ID }))
  const built = buildDealUpdateInput(initial, { ...initial, leadClass: 'B' })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  expect(built.value).toEqual({ leadClass: 'B' })
})

/**
 * An already unassigned deal whose picker is left alone must send nothing at all.
 * Emitting `responsibleUserId: null` here would be a PATCH that clears what is
 * already clear — and, on a deal reassigned in another tab meanwhile, one that
 * silently takes it away.
 */
test('leaving an unassigned deal alone is no change rather than a redundant clear', () => {
  const initial = toDealEditDraft(detail({ responsibleUserId: null }))
  const built = buildDealUpdateInput(initial, { ...initial })

  expect(built.ok).toBe(false)
  if (built.ok) return
  expect(built.errors.formMessage).toBe('Изменений нет')
})

test('assigning an unassigned deal sends the id and nothing else', () => {
  const initial = toDealEditDraft(detail({ responsibleUserId: null }))
  const built = buildDealUpdateInput(initial, { ...initial, responsibleUserId: USER_ID })

  expect(built.ok).toBe(true)
  if (!built.ok) return
  expect(built.value).toEqual({ responsibleUserId: USER_ID })
})

test('the picker offers «Не назначен» first, so unassigning is a real choice', () => {
  const options = assignableUserOptions([
    { id: USER_ID, name: 'Руководитель' },
    { id: OTHER_USER_ID, name: 'manager@teraso.com.ua' },
  ])

  expect(options).toEqual([
    { label: 'Не назначен', value: NOT_SET },
    { label: 'Руководитель', value: USER_ID },
    { label: 'manager@teraso.com.ua', value: OTHER_USER_ID },
  ])
  // The card's placeholder for an empty owner is the same words, so the form and
  // the card never describe the same emptiness differently.
  expect(personLabel(null)).toBe('Не назначен')
})

/* ------------------------------------------------------------------ *
 * Deal card
 * ------------------------------------------------------------------ */

test('the deal card shows the PRD blocks with a readable phone and formatted money', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail()}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).toContain('Олена Ковальчук')
  expect(markup).toContain('+380 67 123 45 67')
  expect(markup).toContain('65 000 ₴')
  expect(markup).toContain('Новая заявка')
  expect(markup).toContain('ДПК')
  expect(markup).toContain('Тераса')
  expect(markup).toContain('Ждёт замер')
  expect(markup).toContain('Telegram')
})

test('raw click identifiers stay out of the operational header', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail({
        attribution: {
          externalId: 'lead_9001',
          metaEventId: 'evt_secret',
          utmSource: 'facebook',
          utmMedium: 'cpc',
          utmCampaign: 'terrace-july',
          utmContent: 'video-a',
          utmTerm: null,
          gclid: 'gclid_secret',
          gbraid: null,
        },
      })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).toContain('Маркетинг')
  expect(markup).not.toContain('gclid_secret')
  expect(markup).not.toContain('evt_secret')
  expect(markup).not.toContain('terrace-july')
})

test('a truncated history says so instead of pretending it is complete', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail({ hasMoreActivities: true })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).toContain(`Показаны последние ${DEAL_DETAIL_ACTIVITY_LIMIT}`)
})

test('a closed deal offers a reopen action and an open deal does not', async () => {
  const won = await renderInRouter(
    <DealDetail
      deal={detail({ stage: 'WON', fullPaymentAmount: '65000.00', fullPaymentPaidAt: '2026-07-25T09:00:00.000Z' })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )
  const lost = await renderInRouter(
    <DealDetail
      deal={detail({ stage: 'LOST', lossReason: 'NO_ANSWER' })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )
  const open = await renderInRouter(
    <DealDetail
      deal={detail()}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  const archived = await renderInRouter(
    <DealDetail
      deal={detail({ stage: 'ARCHIVED' })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(won).toContain('Переоткрыть')
  expect(lost).toContain('Переоткрыть')
  expect(lost).toContain('Недозвон')
  // The archive is a closed stage, so it is reopenable exactly like the other
  // two — the button reads the same OPEN_DEAL_STAGES the server's rule derives
  // its reopen set from, rather than a list of stage names kept in step by hand.
  expect(archived).toContain('Переоткрыть')
  expect(archived).toContain('Архив')
  expect(open).not.toContain('Переоткрыть')
})

/* ------------------------------------------------------------------ *
 * Permanent deletion
 *
 * The only irreversible action in the CRM, so what the confirmation SAYS is
 * part of the behaviour rather than copy: an owner who reads it must be able to
 * tell deletion apart from archiving before they commit to it.
 * ------------------------------------------------------------------ */

test('the card offers no delete action at all without a handler', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail()}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).not.toContain('Удалить')
})

test('the card offers the delete action once a handler is given', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail()}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onDeleteDeal={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).toContain('Удалить')
})

/**
 * The rule behind the confirmation's louder half.
 *
 * A paid deal is the dangerous case: received money is attributed by its own
 * payment date, so erasing the deal quietly lowers a CLOSED period's reported
 * revenue — the one consequence of a deletion that reaches past this card, and
 * the case where «Архив» is almost always what was actually meant.
 *
 * The rule is asserted here rather than through the rendered dialog because a
 * Radix `AlertDialog` portals its content, which a static render never captures.
 * That is also why this is a function rather than an inline `??` in the JSX:
 * the decision to warn is testable, the wording around it is not.
 */
test('the delete warning fires on any recorded money and names the larger figure', () => {
  expect(recordedPaymentAmount(detail())).toBeNull()

  expect(
    recordedPaymentAmount(
      detail({
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-24T09:00:00.000Z',
      }),
    ),
  ).toBe('20000.00')

  // Both recorded: the final figure is the one the warning names.
  expect(
    recordedPaymentAmount(
      detail({
        stage: 'WON',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-24T09:00:00.000Z',
        fullPaymentAmount: '65000.00',
        fullPaymentPaidAt: '2026-07-25T09:00:00.000Z',
      }),
    ),
  ).toBe('65000.00')

  // An archived deal keeps its payments, so shelving one never disarms the
  // warning — deleting it afterwards costs the reports exactly the same.
  expect(
    recordedPaymentAmount(
      detail({
        stage: 'ARCHIVED',
        fullPaymentAmount: '65000.00',
        fullPaymentPaidAt: '2026-07-25T09:00:00.000Z',
      }),
    ),
  ).toBe('65000.00')
})

/* ------------------------------------------------------------------ *
 * Task actions on the deal card (PRD 6.2, PRD 7.4)
 *
 * `TaskActions` is tested directly rather than through `DealDetail`: Radix's
 * `Tabs.Content` renders an empty, hidden panel for every tab except the
 * default one under `renderToStaticMarkup` (there is no jsdom in this suite —
 * `bun test` alone provides no `document`), so a task's action row never
 * reaches the markup `DealDetail` produces for a static render. `TaskActions`
 * is the piece with the actual branching (active vs terminal, direct action vs
 * confirmed one), so testing it on its own is not a loss of coverage.
 * ------------------------------------------------------------------ */

/** The opening tag of the element carrying a given `data-testid`. */
function tagFor(markup: string, testId: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))
  if (!match) throw new Error(`no element with data-testid="${testId}" in markup`)
  return match[0]
}

test('an active task offers to complete, reschedule and cancel it', () => {
  const markup = renderToStaticMarkup(
    <TaskActions isSaving={false} onCancel={noop} onComplete={noop} onReschedule={noop} task={task()} />,
  )

  expect(markup).toContain('Выполнена')
  expect(markup).toContain('Перенести')
  expect(markup).toContain('Отменить')
})

test('a completed or a cancelled task offers no actions, because the server refuses to edit either', () => {
  const completed = renderToStaticMarkup(
    <TaskActions
      isSaving={false}
      onCancel={noop}
      onComplete={noop}
      onReschedule={noop}
      task={task({ status: 'COMPLETED', completedAt: '2026-07-21T09:05:00.000Z' })}
    />,
  )
  const cancelled = renderToStaticMarkup(
    <TaskActions
      isSaving={false}
      onCancel={noop}
      onComplete={noop}
      onReschedule={noop}
      task={task({ status: 'CANCELLED' })}
    />,
  )

  expect(completed).not.toContain('Перенести')
  expect(completed).not.toContain('Отменить')
  // Unambiguous only on the cancelled render: the completed status badge itself
  // reads «Выполнена», so it cannot be used to assert the action is absent.
  expect(cancelled).not.toContain('Перенести')
  expect(cancelled).not.toContain('Отменить')
  expect(cancelled).not.toContain('Выполнена')
})

/**
 * Cancelling is gated behind an explicit confirmation rather than firing on
 * click (PRD 7.0, CLAUDE.md). `aria-haspopup="dialog"` is Radix's own signal
 * that activating this control opens a dialog instead of performing the action
 * directly, and the confirmation copy is not already sitting in the page — it
 * renders through a portal that only mounts once the dialog actually opens, so
 * its absence here confirms the action is not inline.
 */
test('cancel is a trigger for a confirmation dialog, not a direct action', () => {
  const markup = renderToStaticMarkup(
    <TaskActions isSaving={false} onCancel={noop} onComplete={noop} onReschedule={noop} task={task()} />,
  )

  expect(tagFor(markup, 'cancel-task-trigger')).toContain('aria-haspopup="dialog"')
  expect(markup).not.toContain('Отменить задачу?')
})

test('every action is disabled while a save is already in flight', () => {
  const markup = renderToStaticMarkup(
    <TaskActions isSaving onCancel={noop} onComplete={noop} onReschedule={noop} task={task()} />,
  )

  expect(tagFor(markup, 'complete-task')).toContain('disabled=""')
  expect(tagFor(markup, 'reschedule-task')).toContain('disabled=""')
  expect(tagFor(markup, 'cancel-task-trigger')).toContain('disabled=""')
})

/* ------------------------------------------------------------------ *
 * Timeline, contact links and untrusted URLs
 * ------------------------------------------------------------------ */

test('every history entry carries its date and its author', () => {
  const markup = renderToStaticMarkup(
    <ActivityTimeline
      activities={[
        activity(),
        activity({
          id: '77777777-7777-4777-8777-777777777777',
          kind: 'STAGE_CHANGED',
          text: null,
          fromStage: 'NEW',
          toStage: 'QUALIFIED',
          authorName: null,
          authorUserId: null,
          createdAt: '2026-07-21T07:15:00.000Z',
        }),
      ]}
      hasMore={false}
    />,
  )

  expect(markup).toContain('Договорились о замере')
  expect(markup).toContain('owner')
  expect(markup).toContain('Система')
  expect(markup).toContain('Новая заявка')
  expect(markup).toContain('Квалификация пройдена')
  expect(markup.match(/20\.07\.2026|21\.07\.2026/g)?.length).toBe(2)
})

test('contact actions only build links, never send anything', () => {
  expect(contactLinks('+380671234567')).toEqual({
    call: 'tel:+380671234567',
    telegram: 'https://t.me/+380671234567',
    whatsapp: 'https://wa.me/380671234567',
    viber: 'viber://chat?number=%2B380671234567',
  })

  const markup = renderToStaticMarkup(<ContactActions phoneNormalized="+380671234567" />)
  expect(markup).toContain('href="tel:+380671234567"')
  expect(markup).toContain('href="https://wa.me/380671234567"')
  expect(markup).toContain('href="viber://chat?number=%2B380671234567"')
  expect(markup).toContain('Позвонить')
})

test('an untrusted landing URL is never turned into a clickable link', () => {
  expect(safeExternalHref('https://teraso.com.ua/quiz')).toBe('https://teraso.com.ua/quiz')
  expect(safeExternalHref('http://teraso.com.ua/quiz')).toBe('http://teraso.com.ua/quiz')
  expect(safeExternalHref('javascript:alert(1)')).toBeNull()
  expect(safeExternalHref('JavaScript:alert(1)')).toBeNull()
  expect(safeExternalHref('data:text/html,<script>alert(1)</script>')).toBeNull()
  expect(safeExternalHref('not a url')).toBeNull()
  expect(safeExternalHref(null)).toBeNull()
})

test('a deal whose landing URL carries a script scheme renders it as plain text', async () => {
  const markup = await renderInRouter(
    <DealDetail
      deal={detail({ landingUrl: 'javascript:alert(1)' })}
      isSaving={false}
      onAddNote={asyncNoop}
      onChangeStage={noop}
      onSaveNote={noop}
      onUpdateDeal={noop}
    />,
  )

  expect(markup).not.toContain('href="javascript:alert(1)"')
})
