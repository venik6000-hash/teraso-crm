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
} from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { ActivityTimeline } from '../src/features/crm/components/ActivityTimeline'
import { ContactActions } from '../src/features/crm/components/ContactActions'
import { DealDetail } from '../src/features/crm/components/DealDetail'
import { DealForm } from '../src/features/crm/components/DealForm'
import { contactLinks, safeExternalHref } from '../src/features/crm/model'
import { phoneFieldError, toFormErrors } from '../src/features/crm/validation'
import { renderInRouter } from './render-in-router'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_DEAL_ID = '66666666-6666-4666-8666-666666666666'
const CLIENT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '55555555-5555-4555-8555-555555555555'

function client(): ClientSummaryDto {
  return {
    id: CLIENT_ID,
    name: 'Олена Ковальчук',
    phoneNormalized: '+380671234567',
    createdAt: '2026-07-01T09:00:00.000Z',
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

  expect(won).toContain('Переоткрыть')
  expect(lost).toContain('Переоткрыть')
  expect(lost).toContain('Недозвон')
  expect(open).not.toContain('Переоткрыть')
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
