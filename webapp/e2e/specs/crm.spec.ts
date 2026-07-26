import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'
import { e2eAdminEmail, e2eAdminPassword, e2eWebhookSecret } from '../env'
import { expect, test } from '../helpers/test'

/**
 * The CRM's end-to-end journey: a signed quiz lead reaches success (PRD 11).
 *
 * It drives the REAL webhook rather than seeding a row, because idempotency and
 * the auto-created follow-up task are properties of that endpoint. `receivedAt`
 * is backdated well past the 30-minute next-step window while the signature
 * timestamp stays fresh — the two are deliberately separate values — so the
 * deal is already critical by the time the browser opens it, with no waiting.
 *
 * Covers PRD 11 scenarios 1, 2, 4, 6, 7 (through the rejection of a payment-less
 * move) and 9.
 */

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://127.0.0.1:3000'

/** Comfortably past NEXT_STEP_GRACE_MINUTES, so the lead is critical on arrival. */
const RECEIVED_MINUTES_AGO = 90

test('quiz lead reaches success', async ({ page }) => {
  const externalId = `lead_e2e_${Date.now()}`
  const phone = uniquePhone()
  const lead = {
    externalId,
    receivedAt: new Date(Date.now() - RECEIVED_MINUTES_AGO * 60_000).toISOString(),
    name: 'Олена Ковальчук',
    phone,
    source: 'teraso.com.ua',
    form: 'Квіз',
    landingUrl: 'https://teraso.com.ua/kviz',
    material: 'WPC',
    areaLabel: '45 м²',
    budgetLabel: '80 000 грн',
    needTiming: 'Зараз',
    preferredChannel: 'TELEGRAM',
    attribution: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'terrace' },
  }

  /* PRD 11.1 — the webhook creates the client, the deal and its attribution. */
  const created = await deliverLead(lead)
  expect(created.status).toBe('created')
  const dealId = created.dealId

  await signInAsAdministrator(page)

  /* The owner's landing surface is the CRM, not the account console. */
  await expect(page).toHaveURL(/\/app$/)

  /* PRD 11.4 — the lead is visibly critical in the list without any waiting. */
  await page.goto('/app/deals')
  const row = page.getByTestId(`deal-row-${dealId}`)
  await expect(row).toBeVisible()
  await expect(row.getByText('Требует действия')).toBeVisible()

  await row.getByRole('link', { name: /Открыть сделку/ }).click()
  await expect(page).toHaveURL(new RegExp(`/app/deals/${dealId}$`))

  /* The incoming quiz answers are on the card. */
  await expect(page.getByRole('main')).toContainText('Олена Ковальчук')
  await expect(page.getByRole('main')).toContainText('ДПК')
  await expect(page.getByRole('main')).toContainText('45 м²')
  await expect(page.getByRole('main')).toContainText('80 000 грн')
  await expect(page.getByRole('main')).toContainText('teraso.com.ua')

  /* A call note goes into the immutable timeline. */
  await page.getByLabel('Новая запись в ленте').fill('Созвонились, уточняем площадь террасы.')
  await page.getByRole('button', { name: 'Добавить в ленту' }).click()
  await expect(page.getByRole('main')).toContainText('Созвонились, уточняем площадь террасы.')

  /* Class B: ready to buy but one parameter short (PRD 7.2). */
  await setLeadClass(page, 'Класс B')
  await expect(page.getByRole('main')).toContainText('Класс B')

  /*
   * PRD 7.4 — the owner schedules the next step with a mandatory Kyiv date and
   * time. The deal stays critical afterwards, and correctly so: the webhook's
   * own auto-task is already overdue, and an overdue task keeps a deal critical
   * regardless of what else is scheduled.
   */
  await page.getByRole('button', { name: 'Новая задача' }).click()
  await page.getByLabel('Что сделать').fill('Перезвонить и согласовать замер')
  await page.getByTestId('task-due-at').getByLabel('Дата и время').fill(kyivDateTimeInDays(2))
  await page.getByTestId('save-task').click()

  // The timeline records the kind and the due time; the task's own text lives
  // on the tasks tab, which is where the owner reads it.
  await page.getByRole('tab', { name: 'Задачи' }).click()
  await expect(page.getByRole('main')).toContainText('Перезвонить и согласовать замер')

  /* PRD 11.6 — the funnel refuses PREPAYMENT without an amount and a date. */
  await openStageDialog(page, 'Квалификация пройдена')
  await page.getByRole('button', { name: 'Сохранить этап' }).click()
  await expect(page.getByRole('main')).toContainText('Квалификация пройдена')

  await openStageDialog(page, 'Предложение отправлено')
  await page.getByRole('button', { name: 'Сохранить этап' }).click()
  await expect(page.getByRole('main')).toContainText('Предложение отправлено')

  await openStageDialog(page, 'Предоплата')
  await page.getByTestId('mark-prepayment').click()
  // Refused by the shared contract, in Russian, with the dialog still open so
  // the owner can fix the field rather than starting the move again.
  await expect(page.getByText('Укажите сумму в формате 65000.00')).toBeVisible()

  await page.getByLabel('Сумма предоплаты').fill('20000')
  await page.getByLabel('Дата оплаты').fill(kyivDateTimeInDays(0))
  await page.getByTestId('mark-prepayment').click()
  await expect(page.getByRole('main')).toContainText('Предоплата')

  /* PRD 11.6 — full payment closes the deal as won. */
  await openStageDialog(page, 'Успех')
  await page.getByLabel('Сумма полной оплаты').fill('80000')
  await page.getByLabel('Дата оплаты').fill(kyivDateTimeInDays(0))
  await page.getByTestId('mark-won').click()
  await expect(page.getByRole('main')).toContainText('Успех')

  /* PRD 11.9 — the full payment, not the prepayment, is the dashboard's revenue. */
  await page.goto('/app/dashboard')
  await expect(page.getByTestId('dashboard-won-amount')).toContainText('80 000')

  /* PRD 11.2 — replaying the same externalId still leaves exactly one deal. */
  const replay = await deliverLead(lead)
  expect(replay.status).toBe('duplicate-delivery')
  expect(replay.dealId).toBe(dealId)

  await page.goto(`/app/deals?q=${encodeURIComponent(phone)}`)
  await expect(page.getByTestId(`deal-row-${dealId}`)).toHaveCount(1)
  await expect(page.getByRole('main').getByText('Олена Ковальчук')).toHaveCount(1)
})

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Posts a lead exactly as the site does: HMAC-SHA256 over
 * `${timestamp}.${raw body}`, signed with the same raw bytes that are sent.
 * Re-serializing the body would change key order and break the signature.
 */
async function deliverLead(lead: Record<string, unknown>) {
  const body = JSON.stringify(lead)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac('sha256', e2eWebhookSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')

  const response = await fetch(`${BACKEND_URL}/api/crm/inbound/quiz`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-teraso-timestamp': timestamp,
      'x-teraso-signature': signature,
    },
    body,
  })

  expect(response.ok, `webhook rejected the delivery: ${await response.clone().text()}`).toBe(true)
  return (await response.json()) as { status: string; clientId: string; dealId: string }
}

/**
 * Signs in the seeded administrator.
 *
 * Typed key by key and verified: the guest pages swap their subtree as the
 * session bootstrap settles, so a programmatic `fill` landing mid-swap sets a
 * value on an element that is about to be replaced and the controlled input
 * comes back empty.
 */
async function signInAsAdministrator(page: Page) {
  await page.goto('/login')
  await expect(async () => {
    await page.getByLabel('Email').click()
    await page.getByLabel('Email').pressSequentially(e2eAdminEmail)
    await page.getByLabel('Password', { exact: true }).click()
    await page.getByLabel('Password', { exact: true }).pressSequentially(e2eAdminPassword)
    await expect(page.getByLabel('Email')).toHaveValue(e2eAdminEmail)
  }).toPass({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Login' }).click()
}

async function setLeadClass(page: Page, label: string) {
  await page.getByRole('button', { name: 'Редактировать' }).click()
  await page.getByLabel('Класс', { exact: true }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
}

async function openStageDialog(page: Page, stageLabel: string) {
  await page.getByRole('button', { name: 'Изменить этап' }).click()
  await page.getByTestId('deal-stage-select').getByLabel('Новый этап').click()
  await page.getByRole('option', { name: stageLabel, exact: true }).click()
}

/**
 * A `YYYY-MM-DDTHH:mm` value in Kyiv wall-clock time, which is what the form's
 * date-time input speaks (PRD 10).
 */
function kyivDateTimeInDays(days: number) {
  const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(target)
    .replace(' ', 'T')
}

/** Keeps runs independent: a phone is a client's identity in this CRM. */
function uniquePhone() {
  const suffix = String(Date.now()).slice(-7)
  return `+38067${suffix}`
}
