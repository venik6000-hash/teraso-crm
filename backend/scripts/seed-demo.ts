import 'dotenv/config'

import {
  dealCreateSchema,
  dealNoteCreateSchema,
  dealStageChangeSchema,
  dealUpdateSchema,
  inboundQuizLeadSchema,
  taskCreateSchema,
  type DealCreateInput,
  type DealStageChangeInput,
  type DealUpdateInput,
  type InboundQuizLeadInput,
  type TaskCreateInput,
} from '@teraso-crm/contracts'

import { createBackgroundTasks } from '../src/background-tasks'
import { createPrisma, type DbClient } from '../src/db'
import type { AuthenticatedPrincipal } from '../src/modules/auth'
import { CrmService, TaskService } from '../src/modules/crm'
import { kyivDateOf, kyivDayStart } from '../src/modules/crm/domain/kyiv-time'
import { normalizeUaPhone } from '../src/modules/crm/domain/phone'
import { createPrismaCrmRepository } from '../src/modules/crm/infrastructure/crm-repository'
import { createLeadNotifier, createNotificationService } from '../src/modules/notifications'
import { createPrismaUsersRepository } from '../src/modules/users/infrastructure/users-repository'

/**
 * Demonstration data for a local Teraso CRM: ten leads with the history a real
 * month of work leaves behind.
 *
 * Everything is written through the SAME services the API uses — the signed-site
 * ingestion path, `CrmService`, `TaskService` and the notification dispatcher —
 * rather than through hand-written inserts. A row assembled by hand would be free
 * to contradict the funnel rules, skip an activity the timeline expects, or leave
 * an inbound deal without the receipt its idempotency rests on; going through the
 * services means the seeded data is exactly the data the product produces.
 *
 * Two things the services cannot express are corrected afterwards, in one pass at
 * the end (see `backdateRowCreation`): `created_at` columns carry a database
 * default of `now()`, so without that correction a lead "submitted" three weeks
 * ago would still have been created this second — visibly wrong on the card, and
 * behaviourally wrong for the 30-minute next-step grace window that anchors on it.
 *
 * Re-running is safe. Inbound leads deduplicate on their `[source, externalId]`
 * receipt exactly as a redelivered webhook does, and a manual lead is skipped when
 * its client phone is already known, so a second run adds nothing and changes
 * nothing.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error('seed:demo writes fictional customer data and is disabled in production')
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/* ------------------------------------------------------------------ *
 * Scenario shape
 * ------------------------------------------------------------------ */

/**
 * The three people who own work in the demo. `admin` is whoever the local
 * administrator seed created, so the account the owner signs in with sees deals,
 * tasks and notifications addressed to them; the other two exist to make the
 * «ответственный» picker and its list filter worth trying.
 */
type StaffKey = 'admin' | 'iryna' | 'dmytro'

/** Resolves a due instant for a task, given when its step runs. */
type DueAt = (context: { at: Date; now: Date }) => Date

type ScenarioStep =
  /** Hours after the lead arrived. The clock is moved here before the step runs. */
  | { after: number; kind: 'note'; text: string }
  | { after: number; kind: 'patch'; patch: DealUpdateInput }
  | { after: number; kind: 'assign'; to: StaffKey }
  | { after: number; kind: 'stage'; change: DealStageChangeInput }
  | { after: number; kind: 'task'; task: Omit<TaskCreateInput, 'dueAt'> & { dueAt: DueAt } }
  | { after: number; kind: 'finish-tasks' }

type Scenario = {
  /** Days before the run this lead arrived; fractions are hours. */
  daysAgo: number
  /** Present for a lead that came from the site, absent for one taken by hand. */
  inbound?: {
    externalId: string
    form: string
    landingUrl: string
    attribution?: InboundQuizLeadInput['attribution']
  }
  lead: {
    name: string
    phone: string
    source: string
    material?: InboundQuizLeadInput['material']
    areaLabel?: string
    budgetLabel?: string
    needTiming?: string
    preferredChannel?: InboundQuizLeadInput['preferredChannel']
  }
  /** Only a manual lead carries these: the site never fills them in. */
  manual?: Pick<DealCreateInput, 'form' | 'objectType' | 'currentNote'> & {
    responsible?: StaffKey
    initialTask?: Omit<TaskCreateInput, 'dueAt'> & { dueAt: DueAt }
  }
  steps: ScenarioStep[]
}

/* ------------------------------------------------------------------ *
 * Due-time helpers
 * ------------------------------------------------------------------ */

/** `hours` after the step that creates the task. */
const inHours = (hours: number): DueAt => ({ at }) => new Date(at.getTime() + hours * HOUR_MS)

/**
 * A wall-clock hour on a Kyiv calendar day relative to today, which is how a
 * person schedules a call ("завтра в 10:00") and how the dashboard counts
 * «задачи на сегодня» — that counter is a Kyiv-day range, so a task meant to land
 * in it has to be placed in Kyiv time rather than a fixed offset from now.
 */
const atKyivHour =
  (dayOffset: number, hour: number, minute = 0): DueAt =>
  ({ now }) => {
    const day = new Date(Date.parse(`${kyivDateOf(now)}T00:00:00.000Z`) + dayOffset * DAY_MS)
    return new Date(kyivDayStart(day.toISOString().slice(0, 10)).getTime() + hour * HOUR_MS + minute * MINUTE_MS)
  }

/* ------------------------------------------------------------------ *
 * The ten leads
 *
 * Kyiv-region decking and facade work: WPC terraces, wood, ventilated facades.
 * Stages are spread across the whole funnel so the board has every column
 * populated, and the money and stage moves fall inside the dashboard's trailing
 * 30-day window so the report is not an empty shell.
 * ------------------------------------------------------------------ */

const SCENARIOS: Scenario[] = [
  /* 1 — the full journey: quiz lead to paid installation. */
  {
    daysAgo: 26,
    inbound: {
      externalId: 'demo-lead-001',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/kviz',
      attribution: {
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'terasa-dpk-kyiv',
        utmContent: 'search-brand',
        gclid: 'Cj0KCQdemo001',
      },
    },
    lead: {
      name: 'Олександра Мельник',
      phone: '+380671234501',
      source: 'teraso.com.ua',
      material: 'WPC',
      areaLabel: '48 м²',
      budgetLabel: '250 000 – 300 000 грн',
      needTiming: 'Протягом місяця',
      preferredChannel: 'TELEGRAM',
    },
    steps: [
      { after: 0.4, kind: 'assign', to: 'admin' },
      { after: 0.5, kind: 'finish-tasks' },
      {
        after: 0.6,
        kind: 'note',
        text: 'Созвонились. Дом в Козине, терраса вокруг бассейна, нужен монтаж под ключ до конца месяца.',
      },
      {
        after: 1,
        kind: 'patch',
        patch: {
          leadClass: 'A',
          potentialAmount: '268000',
          objectType: 'Частный дом',
          currentNote: 'Терраса 48 м² вокруг бассейна, ДПК премиум, монтаж под ключ.',
        },
      },
      { after: 1.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 1.2,
        kind: 'task',
        task: { kind: 'CLARIFY', title: 'Выехать на замер в Козин', dueAt: inHours(46) },
      },
      { after: 48, kind: 'finish-tasks' },
      { after: 48.2, kind: 'note', text: 'Замер сделан: 48,6 м², перепад 12 см, нужна регулируемая опора.' },
      {
        after: 72,
        kind: 'stage',
        change: { stage: 'PROPOSAL_SENT', comment: 'Отправили КП на 268 000 грн: террасная доска премиум + монтаж.' },
      },
      {
        after: 72.1,
        kind: 'task',
        task: { kind: 'CALL', title: 'Уточнить решение по КП', dueAt: inHours(48) },
      },
      { after: 120, kind: 'finish-tasks' },
      {
        after: 168,
        kind: 'stage',
        change: {
          stage: 'PREPAYMENT',
          prepaymentAmount: '80400',
          comment: 'Внесла предоплату 30%, монтаж запланировали на следующую неделю.',
        },
      },
      {
        after: 168.1,
        kind: 'task',
        task: { kind: 'OTHER', title: 'Проконтролировать монтаж', dueAt: inHours(96) },
      },
      { after: 264, kind: 'finish-tasks' },
      {
        after: 336,
        kind: 'stage',
        change: {
          stage: 'WON',
          fullPaymentAmount: '268000',
          comment: 'Монтаж завершён, остаток оплачен. Клиентка обещала рекомендации соседям.',
        },
      },
    ],
  },

  /* 2 — prepaid, installation ahead: money in the period, work still open. */
  {
    daysAgo: 21,
    inbound: {
      externalId: 'demo-lead-002',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/fasady',
      attribution: {
        utmSource: 'facebook',
        utmMedium: 'paid_social',
        utmCampaign: 'fasad-remarketing',
        utmContent: 'carousel-3',
        metaEventId: 'demo-meta-002',
      },
    },
    lead: {
      name: 'Ігор Бондаренко',
      phone: '+380631234502',
      source: 'teraso.com.ua',
      material: 'FACADE',
      areaLabel: '210 м²',
      budgetLabel: 'до 450 000 грн',
      needTiming: 'Цього сезону',
      preferredChannel: 'CALL',
    },
    steps: [
      { after: 0.3, kind: 'assign', to: 'iryna' },
      { after: 0.4, kind: 'finish-tasks' },
      { after: 0.5, kind: 'note', text: 'Двухэтажный дом в Ирпене, вентфасад под ключ, есть проект от архитектора.' },
      {
        after: 1,
        kind: 'patch',
        patch: {
          leadClass: 'A',
          potentialAmount: '415000',
          objectType: 'Частный дом',
          currentNote: 'Вентфасад 210 м², проект от архитектора на руках.',
        },
      },
      { after: 1.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      { after: 24, kind: 'note', text: 'Согласовали цвет и раскладку по проекту, считаем смету.' },
      {
        after: 96,
        kind: 'stage',
        change: { stage: 'PROPOSAL_SENT', comment: 'КП на 415 000 грн отправлено, включён монтаж и подсистема.' },
      },
      {
        after: 288,
        kind: 'stage',
        change: {
          stage: 'PREPAYMENT',
          prepaymentAmount: '124500',
          comment: 'Предоплата 30% получена, материал заказан у поставщика.',
        },
      },
      {
        after: 288.2,
        kind: 'task',
        task: { kind: 'CALL', title: 'Согласовать дату монтажа', dueAt: atKyivHour(2, 12) },
      },
    ],
  },

  /* 3 — proposal out, follow-up call due today: feeds «задачи на сегодня». */
  {
    daysAgo: 14,
    inbound: {
      externalId: 'demo-lead-003',
      form: 'Форма зворотного дзвінка',
      landingUrl: 'https://teraso.com.ua/terasna-doshka',
      attribution: { utmSource: 'google', utmMedium: 'organic' },
    },
    lead: {
      name: 'Наталія Ковальчук',
      phone: '+380501234503',
      source: 'teraso.com.ua',
      material: 'WOOD',
      areaLabel: '22 м²',
      budgetLabel: '90 000 – 110 000 грн',
      needTiming: 'Через 2-3 місяці',
      preferredChannel: 'VIBER',
    },
    steps: [
      { after: 0.3, kind: 'assign', to: 'admin' },
      { after: 0.4, kind: 'finish-tasks' },
      { after: 0.5, kind: 'note', text: 'Балкон-терраса в таунхаусе на Осокорках, интересует термоясень.' },
      {
        after: 1,
        kind: 'patch',
        patch: {
          leadClass: 'B',
          potentialAmount: '96000',
          objectType: 'Таунхаус',
          needTiming: 'Через 2-3 месяца',
          currentNote: 'Термоясень, 22 м². Решение после отпуска мужа.',
        },
      },
      { after: 1.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 72,
        kind: 'stage',
        change: { stage: 'PROPOSAL_SENT', comment: 'Отправили два варианта: термоясень и лиственница.' },
      },
      {
        after: 72.2,
        kind: 'task',
        task: { kind: 'CALL', title: 'Перезвонить по КП: термоясень или лиственница', dueAt: atKyivHour(0, 18) },
      },
    ],
  },

  /* 4 — lost to a competitor: the funnel needs a closed-lost example too. */
  {
    daysAgo: 9,
    inbound: {
      externalId: 'demo-lead-004',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/kviz',
      attribution: {
        utmSource: 'instagram',
        utmMedium: 'paid_social',
        utmCampaign: 'terasa-summer',
        utmContent: 'reels-2',
      },
    },
    lead: {
      name: 'Володимир Ткаченко',
      phone: '+380931234504',
      source: 'teraso.com.ua',
      material: 'WPC',
      areaLabel: '30 м²',
      budgetLabel: 'до 150 000 грн',
      needTiming: 'Зараз',
      preferredChannel: 'WHATSAPP',
    },
    steps: [
      { after: 0.5, kind: 'assign', to: 'dmytro' },
      { after: 0.6, kind: 'finish-tasks' },
      { after: 0.7, kind: 'note', text: 'Сравнивает три подрядчика, главный критерий — срок монтажа.' },
      {
        after: 1,
        kind: 'patch',
        patch: { leadClass: 'B', potentialAmount: '142000', objectType: 'Дача' },
      },
      { after: 1.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 96,
        kind: 'stage',
        change: {
          stage: 'LOST',
          lossReason: 'CHOSEN_COMPETITOR',
          comment: 'Ушёл к подрядчику, который дал монтаж на две недели раньше. Цена была не решающей.',
        },
      },
    ],
  },

  /* 5 — qualified but the call was missed: an overdue task makes it critical. */
  {
    daysAgo: 5,
    inbound: {
      externalId: 'demo-lead-005',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/kviz',
      attribution: {
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'terasa-dpk-kyiv',
        utmTerm: 'террасная доска дпк',
        gclid: 'Cj0KCQdemo005',
      },
    },
    lead: {
      name: 'Марина Шевченко',
      phone: '+380681234505',
      source: 'teraso.com.ua',
      material: 'WPC',
      areaLabel: '35 м²',
      budgetLabel: '180 000 – 200 000 грн',
      needTiming: 'Протягом місяця',
      preferredChannel: 'TELEGRAM',
    },
    steps: [
      { after: 0.4, kind: 'assign', to: 'admin' },
      { after: 0.5, kind: 'finish-tasks' },
      { after: 0.6, kind: 'note', text: 'Терраса у дома в Софиевской Борщаговке, хочет тёмный ДПК с текстурой.' },
      {
        after: 1,
        kind: 'patch',
        patch: {
          leadClass: 'A',
          potentialAmount: '187000',
          objectType: 'Частный дом',
          currentNote: 'Ждёт расчёт с тёмным ДПК и скрытым крепежом.',
        },
      },
      { after: 1.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 1.2,
        kind: 'task',
        task: { kind: 'CALL', title: 'Отправить расчёт и созвониться', dueAt: atKyivHour(-1, 11) },
      },
    ],
  },

  /* 6 — nobody has touched it: the auto-task is overdue and it has no owner. */
  {
    daysAgo: 2,
    inbound: {
      externalId: 'demo-lead-006',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/fasady',
      attribution: {
        utmSource: 'facebook',
        utmMedium: 'paid_social',
        utmCampaign: 'fasad-remarketing',
        metaEventId: 'demo-meta-006',
      },
    },
    lead: {
      name: 'Андрій Кравець',
      phone: '+380971234506',
      source: 'teraso.com.ua',
      material: 'FACADE',
      areaLabel: '85 м²',
      budgetLabel: 'ще не визначився',
      needTiming: 'Наступного року',
      preferredChannel: 'CALL',
    },
    steps: [],
  },

  /* 7 — arrived minutes ago: still inside its grace window, nothing is late. */
  {
    daysAgo: 15 / (24 * 60),
    inbound: {
      externalId: 'demo-lead-007',
      form: 'Квіз',
      landingUrl: 'https://teraso.com.ua/kviz',
      attribution: {
        utmSource: 'instagram',
        utmMedium: 'paid_social',
        utmCampaign: 'terasa-summer',
        utmContent: 'stories-1',
      },
    },
    lead: {
      name: 'Юлія Романенко',
      phone: '+380661234507',
      source: 'teraso.com.ua',
      material: 'WPC',
      areaLabel: '18 м²',
      budgetLabel: 'до 90 000 грн',
      needTiming: 'Зараз',
      preferredChannel: 'TELEGRAM',
    },
    steps: [],
  },

  /* 8 — taken over the phone and won: a manual deal with a full funnel. */
  {
    daysAgo: 18,
    lead: {
      name: 'Сергій Пилипенко',
      phone: '+380501234508',
      source: 'Телефонний дзвінок',
      material: 'WOOD',
      areaLabel: '26 м²',
      budgetLabel: '170 000 – 190 000 грн',
      needTiming: 'Цього сезону',
      preferredChannel: 'CALL',
    },
    manual: {
      form: 'Вхідний дзвінок',
      objectType: 'Ресторан',
      currentNote: 'Летняя терраса ресторана, монтаж только по ночам.',
      responsible: 'iryna',
      initialTask: {
        kind: 'CLARIFY',
        title: 'Выехать на замер террасы ресторана',
        dueAt: inHours(24),
      },
    },
    steps: [
      { after: 0.2, kind: 'note', text: 'Звонок от управляющего: терраса на 26 м², работать можно только ночью.' },
      { after: 24, kind: 'finish-tasks' },
      {
        after: 24.2,
        kind: 'patch',
        patch: { leadClass: 'A', potentialAmount: '176000', needTiming: 'В этом сезоне' },
      },
      { after: 24.3, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 48,
        kind: 'stage',
        change: { stage: 'PROPOSAL_SENT', comment: 'КП на лиственницу с ночным монтажом — 176 000 грн.' },
      },
      {
        after: 120,
        kind: 'stage',
        change: {
          stage: 'PREPAYMENT',
          prepaymentAmount: '88000',
          comment: 'Предоплата 50% по счёту от юрлица.',
        },
      },
      {
        after: 360,
        kind: 'stage',
        change: {
          stage: 'WON',
          fullPaymentAmount: '176000',
          comment: 'Терраса сдана за три ночи, остаток оплачен, ресторан открылся в срок.',
        },
      },
    ],
  },

  /* 9 — from Instagram Direct, measurement booked: a healthy open deal. */
  {
    daysAgo: 6,
    lead: {
      name: 'Оксана Гриценко',
      phone: '+380931234509',
      source: 'Instagram Direct',
      material: 'WPC',
      areaLabel: '40 м²',
      budgetLabel: '120 000 – 140 000 грн',
      needTiming: 'Протягом місяця',
      preferredChannel: 'TELEGRAM',
    },
    manual: {
      form: 'Direct',
      objectType: 'Частный дом',
      currentNote: 'Пишет в Direct, отвечает вечером.',
      responsible: 'admin',
      initialTask: { kind: 'MESSAGE', title: 'Ответить в Direct и собрать размеры', dueAt: inHours(3) },
    },
    steps: [
      { after: 3, kind: 'finish-tasks' },
      { after: 3.2, kind: 'note', text: 'Прислала фото участка и размеры: 40 м², выход из кухни на юг.' },
      {
        after: 4,
        kind: 'patch',
        patch: { leadClass: 'B', potentialAmount: '132000' },
      },
      { after: 4.1, kind: 'stage', change: { stage: 'QUALIFIED' } },
      {
        after: 4.2,
        kind: 'task',
        task: { kind: 'CLARIFY', title: 'Выездной замер, ул. Садовая 14', dueAt: atKyivHour(2, 10) },
      },
    ],
  },

  /* 10 — a recommendation nobody scheduled: critical for having no next step. */
  {
    daysAgo: 1,
    lead: {
      name: 'Тарас Дяченко',
      phone: '+380671234510',
      source: 'Рекомендація',
      material: 'FACADE',
      areaLabel: '120 м²',
      needTiming: 'Навесні',
      preferredChannel: 'CALL',
    },
    manual: {
      form: 'Рекомендація від клієнта',
      objectType: 'Частный дом',
      currentNote: 'Пришёл по рекомендации Олександры Мельник.',
      responsible: 'dmytro',
    },
    steps: [
      { after: 0.2, kind: 'note', text: 'Рекомендация от клиентки из Козина. Просил перезвонить, когда будет время.' },
    ],
  },
]

/* ------------------------------------------------------------------ *
 * Staff
 * ------------------------------------------------------------------ */

/**
 * The two colleagues the demo needs beyond the local administrator.
 *
 * They are created as administrators because the «ответственный» picker is the
 * administrator roster (PRD 3, PRD 7.1) — a deal handed to anyone else could not
 * be opened by its owner, and the notifications addressed to them would go
 * nowhere. They are created WITHOUT a password credential on purpose: demo data
 * must not ship a working login, and nothing in the demo needs one.
 */
const COLLEAGUES: Array<{ key: Exclude<StaffKey, 'admin'>; email: string; displayName: string }> = [
  { key: 'iryna', email: 'iryna@example.com', displayName: 'Ирина Левченко' },
  { key: 'dmytro', email: 'dmytro@example.com', displayName: 'Дмитрий Савченко' },
]

async function resolveStaff(db: DbClient): Promise<Record<StaffKey, { id: string; name: string }>> {
  const administrator = await db.user.findFirst({
    where: { role: 'admin' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, email: true, displayName: true, createdAt: true },
  })
  if (!administrator) {
    throw new Error(
      'No administrator exists yet. Run `bun run --cwd backend prisma:seed` before seeding demo data.',
    )
  }

  const staff = {
    admin: { id: administrator.id, name: administrator.displayName ?? administrator.email },
  } as Record<StaffKey, { id: string; name: string }>

  for (const colleague of COLLEAGUES) {
    const user = await db.user.upsert({
      where: { email: colleague.email },
      // An existing account keeps its password and role decisions; only the
      // display name is asserted, so re-running never touches a real login.
      update: { displayName: colleague.displayName },
      create: { email: colleague.email, displayName: colleague.displayName, role: 'admin' },
      select: { id: true, displayName: true, email: true },
    })
    staff[colleague.key] = { id: user.id, name: user.displayName ?? user.email }
  }

  return staff
}

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

/**
 * Row-creation instants the services could not set, collected while the scenarios
 * run and applied in one pass at the end. See the file header.
 */
type Backdate = {
  clients: Map<string, Date>
  deals: Map<string, Date>
  tasks: Map<string, Date>
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required to seed demo data')

  const prisma = createPrisma(databaseUrl)
  const backgroundTasks = createBackgroundTasks()

  try {
    const staff = await resolveStaff(prisma)
    const actor = await principalFor(prisma, staff.admin.id)

    /**
     * A clock the scenarios move backwards. Every activity row, task event and
     * stage transition is stamped with `clock.now()`, so replaying a month of work
     * against a moving clock produces a timeline that reads like one — and puts the
     * stage moves inside the dashboard's trailing window, where the funnel report
     * looks for them.
     */
    let at = new Date()
    const clock = { now: () => at }
    /**
     * Deliberately NOT the rewound clock above. A delivery pass budgets itself
     * against wall-clock time, so handing it a clock that jumps a month backwards
     * mid-run makes every pass believe it has overrun and abandon its records as
     * PENDING. Only the CRM history is written in the past; the announcements are
     * made now, and `realignNotificationTimes` dates them afterwards.
     */
    const notifications = createNotificationService({ backgroundTasks, db: prisma })
    const repository = createPrismaCrmRepository(prisma)
    const crm = new CrmService({
      assignableUsers: createPrismaUsersRepository(prisma),
      clock,
      notifier: createLeadNotifier(notifications),
      repository,
    })
    const tasks = new TaskService({ clock, repository })

    const now = new Date()
    const backdate: Backdate = { clients: new Map(), deals: new Map(), tasks: new Map() }
    let created = 0
    let skipped = 0

    for (const scenario of SCENARIOS) {
      const submittedAt = new Date(now.getTime() - scenario.daysAgo * DAY_MS)
      at = submittedAt

      const dealId = scenario.inbound
        ? await createInboundDeal(crm, scenario, submittedAt)
        : await createManualDeal(crm, prisma, scenario, submittedAt, staff, actor)

      if (!dealId) {
        skipped += 1
        continue
      }
      created += 1

      const deal = await crm.getDeal(dealId, actor)
      backdate.deals.set(dealId, submittedAt)
      backdate.clients.set(deal.client.id, submittedAt)
      for (const task of deal.tasks) backdate.tasks.set(task.id, submittedAt)

      for (const step of scenario.steps) {
        at = new Date(submittedAt.getTime() + step.after * HOUR_MS)
        await runStep({ actor, at, backdate, crm, dealId, now, staff, step, tasks })
      }
    }

    await backdateRowCreation(prisma, backdate)

    /**
     * The recurring half of PRD 7.7, run once so the inbox is not just the new-lead
     * announcements the ingestion path already made: this is what adds the
     * «пора выполнить задачу», «просроченная задача» and «заявка без следующего
     * шага» records for everything that came due in the last day.
     */
    at = new Date()
    const dispatch = await notifications.dispatchDueEvents(at)
    await realignNotificationTimes(prisma, backdate.deals)
    await backgroundTasks.drain(10_000)

    console.log(
      [
        `Seeded ${created} demo deals (${skipped} already present, left untouched).`,
        `Notification dispatch created ${dispatch.created} records.`,
        `Colleagues available as «ответственный»: ${COLLEAGUES.map((one) => one.displayName).join(', ')} (no login credential).`,
      ].join('\n'),
    )
  } finally {
    await backgroundTasks.drain(5_000)
    await prisma.$disconnect()
  }
}

/**
 * Delivers one lead through the signed-site ingestion path. Returns null when the
 * receipt already exists — a redelivery, which is precisely how re-running this
 * script stays harmless.
 */
async function createInboundDeal(
  crm: CrmService,
  scenario: Scenario,
  submittedAt: Date,
): Promise<string | null> {
  const inbound = scenario.inbound!
  const payload = inboundQuizLeadSchema.parse({
    externalId: inbound.externalId,
    receivedAt: submittedAt.toISOString(),
    name: scenario.lead.name,
    phone: scenario.lead.phone,
    source: scenario.lead.source,
    form: inbound.form,
    landingUrl: inbound.landingUrl,
    material: scenario.lead.material,
    areaLabel: scenario.lead.areaLabel,
    budgetLabel: scenario.lead.budgetLabel,
    needTiming: scenario.lead.needTiming,
    preferredChannel: scenario.lead.preferredChannel,
    attribution: inbound.attribution,
  } satisfies InboundQuizLeadInput)

  const result = await crm.recordInboundQuizLead(payload)
  return result.status === 'duplicate-delivery' ? null : result.dealId
}

/**
 * Creates a lead somebody took by hand. Returns null when the client's phone is
 * already known: the manual path has no receipt to deduplicate on, and the phone
 * IS the client's identity (PRD 5), so a known number means this scenario ran.
 */
async function createManualDeal(
  crm: CrmService,
  db: DbClient,
  scenario: Scenario,
  submittedAt: Date,
  staff: Record<StaffKey, { id: string }>,
  actor: AuthenticatedPrincipal,
): Promise<string | null> {
  const manual = scenario.manual!
  const existing = await db.client.findUnique({
    where: { phoneNormalized: normalizeUaPhone(scenario.lead.phone) },
    select: { id: true },
  })
  if (existing) return null

  const input = dealCreateSchema.parse({
    name: scenario.lead.name,
    phone: scenario.lead.phone,
    source: scenario.lead.source,
    form: manual.form,
    submittedAt: submittedAt.toISOString(),
    responsibleUserId: manual.responsible ? staff[manual.responsible].id : undefined,
    material: scenario.lead.material,
    areaLabel: scenario.lead.areaLabel,
    budgetLabel: scenario.lead.budgetLabel,
    objectType: manual.objectType,
    needTiming: scenario.lead.needTiming,
    preferredChannel: scenario.lead.preferredChannel,
    currentNote: manual.currentNote,
    initialTask: manual.initialTask
      ? taskCreateSchema.parse({
          kind: manual.initialTask.kind,
          title: manual.initialTask.title,
          dueAt: manual.initialTask.dueAt({ at: submittedAt, now: submittedAt }).toISOString(),
        })
      : undefined,
  } satisfies DealCreateInput)

  const deal = await crm.createDeal(input, actor)
  return deal.id
}

type StepContext = {
  actor: AuthenticatedPrincipal
  /** The instant this step runs at; the seeding clock is already set to it. */
  at: Date
  backdate: Backdate
  crm: CrmService
  dealId: string
  now: Date
  staff: Record<StaffKey, { id: string }>
  step: ScenarioStep
  tasks: TaskService
}

async function runStep({ actor, at, backdate, crm, dealId, now, staff, step, tasks }: StepContext) {
  switch (step.kind) {
    case 'note': {
      await crm.addNote(dealId, dealNoteCreateSchema.parse({ text: step.text }), actor)
      return
    }
    case 'assign': {
      await crm.updateDeal(
        dealId,
        dealUpdateSchema.parse({ responsibleUserId: staff[step.to].id } satisfies DealUpdateInput),
        actor,
      )
      return
    }
    case 'patch': {
      await crm.updateDeal(dealId, dealUpdateSchema.parse(step.patch), actor)
      return
    }
    case 'stage': {
      /**
       * A payment date is the instant the step itself runs. It is written here
       * rather than in the scenario so the money lands on the same day as the
       * transition that recorded it, however far back the scenario reaches.
       */
      const change = dealStageChangeSchema.parse({
        ...step.change,
        ...(step.change.stage === 'PREPAYMENT' ? { prepaymentPaidAt: at.toISOString() } : {}),
        ...(step.change.stage === 'WON' ? { fullPaymentPaidAt: at.toISOString() } : {}),
      } satisfies DealStageChangeInput)
      await crm.changeStage(dealId, change, actor)
      return
    }
    case 'task': {
      const created = await tasks.createTask(
        dealId,
        taskCreateSchema.parse({
          kind: step.task.kind,
          title: step.task.title,
          dueAt: step.task.dueAt({ at, now }).toISOString(),
        } satisfies TaskCreateInput),
        actor,
      )
      backdate.tasks.set(created.id, at)
      return
    }
    case 'finish-tasks': {
      const deal = await crm.getDeal(dealId, actor)
      for (const task of deal.tasks) {
        if (task.status !== 'ACTIVE') continue
        await tasks.updateTask(task.id, { status: 'COMPLETED' }, actor)
      }
      return
    }
  }
}

async function principalFor(db: DbClient, userId: string): Promise<AuthenticatedPrincipal> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, role: true, createdAt: true },
  })
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    // The CRM services never read it; the principal type requires one.
    sessionId: crypto.randomUUID(),
  }
}

/**
 * Aligns the `created_at` columns the database defaulted to `now()` with the
 * moment the demo says the row appeared.
 *
 * This is the one place that writes columns directly, and it is deliberately
 * narrow: it touches nothing but creation instants, only on rows this run just
 * created. Without it every "three weeks ago" lead would still be inside its
 * 30-minute next-step grace window, so no deal would ever be critical for lacking
 * a next step and the whole urgency surface would look inert.
 */
async function backdateRowCreation(db: DbClient, backdate: Backdate) {
  for (const [id, createdAt] of backdate.clients) {
    await db.client.update({ where: { id }, data: { createdAt } })
  }
  for (const [id, createdAt] of backdate.deals) {
    await db.deal.update({ where: { id }, data: { createdAt } })
  }
  for (const [id, createdAt] of backdate.tasks) {
    await db.dealTask.update({ where: { id }, data: { createdAt } })
  }
}

/**
 * Dates the «Новая заявка» announcements to the leads that caused them, and marks
 * the ones older than a week as read.
 *
 * The inbox is ordered by creation, and the ingestion path stamps a notification
 * when it runs — which for a seeded month of leads is all within the same second.
 * Left alone the centre would show a month of history as one indistinguishable
 * block, and every record unread, which is not what an inbox in use looks like.
 */
async function realignNotificationTimes(db: DbClient, deals: Map<string, Date>) {
  const readBefore = new Date(Date.now() - 7 * DAY_MS)

  for (const [dealId, createdAt] of deals) {
    await db.notification.updateMany({
      where: { dealId, kind: 'NEW_LEAD' },
      data: {
        createdAt,
        readAt: createdAt < readBefore ? new Date(createdAt.getTime() + HOUR_MS) : null,
      },
    })
  }
}

if (import.meta.main) {
  await main()
}
