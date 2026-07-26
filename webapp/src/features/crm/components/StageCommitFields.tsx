import {
  dealStageChangeSchema,
  lossReasonSchema,
  type DealStage,
  type DealStageChangeInput,
  type LossReason,
} from '@teraso-crm/contracts'

import { toKyivDateTimeInput } from '@/platform/kyiv-time'
import { LOSS_REASON_LABELS, toInstantFromKyivInput } from '../model'
import { toFormErrors, type FormErrors } from '../validation'
import { CrmSelectField, CrmTextField, CrmTextareaField } from './CrmField'

/**
 * The fields a stage move may carry, and the one place that assembles them.
 *
 * Both surfaces that move a deal — the card's stage dialog and the board's drop
 * confirmation — render THIS component and call THIS builder, so the payment and
 * loss-reason rules are written once. Two copies would have to be kept in step
 * with `dealStageChangeSchema`, and the copy nobody was looking at is the one
 * that would drift.
 *
 * Nothing here decides whether the transition itself is legal: that graph is
 * server-authoritative (see `boardDropIntent`).
 */

export type StageCommitDraft = {
  amount: string
  comment: string
  lossReason: LossReason | null
  paidAt: string
}

export function emptyStageCommitDraft(now = new Date()): StageCommitDraft {
  return {
    amount: '',
    comment: '',
    lossReason: null,
    // Payments are normally recorded when they land, so "now" is the right
    // default here — unlike a task, where "now" would mean "already overdue".
    paidAt: toKyivDateTimeInput(now.toISOString()),
  }
}

export function stageNeedsPayment(stage: DealStage): stage is 'PREPAYMENT' | 'WON' {
  return stage === 'PREPAYMENT' || stage === 'WON'
}

/**
 * Assembles and validates the payload for a move to `stage`.
 *
 * Conditional fields are guarded in BOTH directions by the contract: a payment
 * attached to a non-paid stage is rejected as firmly as a missing one, because
 * the dashboard attributes received money by payment date rather than by stage
 * and a stray date would be reported to the owner as revenue.
 */
export function buildStageChangeInput(
  stage: DealStage,
  draft: StageCommitDraft,
): { ok: true; value: DealStageChangeInput } | { ok: false; errors: FormErrors } {
  const payload: Record<string, unknown> = { stage }

  if (draft.comment.trim()) payload.comment = draft.comment.trim()
  if (stage === 'LOST') payload.lossReason = draft.lossReason ?? undefined
  if (stage === 'PREPAYMENT') {
    payload.prepaymentAmount = draft.amount.trim()
    payload.prepaymentPaidAt = toInstantFromKyivInput(draft.paidAt)
  }
  if (stage === 'WON') {
    payload.fullPaymentAmount = draft.amount.trim()
    payload.fullPaymentPaidAt = toInstantFromKyivInput(draft.paidAt)
  }

  const parsed = dealStageChangeSchema.safeParse(payload)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFormErrors(parsed.error.issues) }
}

export function StageCommitFields({
  draft,
  errors,
  onChange,
  stage,
}: {
  draft: StageCommitDraft
  errors: FormErrors
  onChange: (draft: StageCommitDraft) => void
  stage: DealStage
}) {
  const needsPayment = stageNeedsPayment(stage)

  return (
    <div className="grid gap-4">
      {stage === 'LOST' && (
        <CrmSelectField
          error={errors.fields.lossReason}
          label="Причина потери"
          onChange={(value) => onChange({ ...draft, lossReason: lossReasonSchema.parse(value) })}
          options={lossReasonSchema.options.map((option) => ({
            label: LOSS_REASON_LABELS[option],
            value: option,
          }))}
          placeholder="Выберите причину"
          value={draft.lossReason ?? undefined}
        />
      )}

      {needsPayment && (
        <div className="grid gap-4 sm:grid-cols-2">
          <CrmTextField
            error={errors.fields.prepaymentAmount ?? errors.fields.fullPaymentAmount}
            inputMode="decimal"
            label={stage === 'PREPAYMENT' ? 'Сумма предоплаты' : 'Сумма полной оплаты'}
            onChange={(value) => onChange({ ...draft, amount: value })}
            placeholder="65000.00"
            value={draft.amount}
          />
          <CrmTextField
            description="Время по Киеву"
            error={errors.fields.prepaymentPaidAt ?? errors.fields.fullPaymentPaidAt}
            label="Дата оплаты"
            onChange={(value) => onChange({ ...draft, paidAt: value })}
            type="datetime-local"
            value={draft.paidAt}
          />
        </div>
      )}

      {/* Stored as a NOTE_ADDED activity — the same concept as a manual note,
          which is why a loss comment and a note share one field on the wire. */}
      <CrmTextareaField
        error={errors.fields.comment}
        label="Комментарий в ленту"
        maxLength={4000}
        onChange={(value) => onChange({ ...draft, comment: value })}
        rows={2}
        value={draft.comment}
      />
    </div>
  )
}
