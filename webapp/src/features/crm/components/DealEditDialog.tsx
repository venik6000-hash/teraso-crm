import {
  leadClassSchema,
  materialSchema,
  preferredChannelSchema,
  type AssignableUserDto,
  type DealDetailDto,
  type DealUpdateInput,
} from '@teraso-crm/contracts'
import { useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Typography } from '@/components/typography'
import {
  DEAL_FIELD_LABELS,
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  NOT_SET,
  PREFERRED_CHANNEL_LABELS,
  assignableUserOptions,
  buildDealUpdateInput,
  toDealEditDraft,
  type DealEditDraft,
} from '../model'
import { emptyFormErrors } from '../validation'
import { CrmSelectField, CrmTextField } from './CrmField'

/**
 * Edits the working fields of a deal (PRD 7.1: «Все поля редактируемы»).
 *
 * Stage, payment fields and the loss reason are deliberately absent — they move
 * only through the funnel action, so a field edit cannot bypass the rules or
 * hand a deal a payment date it never earned.
 *
 * Only changed fields are sent: an untouched key leaves the stored value alone
 * and an emptied optional field is sent as an explicit `null` to clear it. That
 * diff is `buildDealUpdateInput`, kept in the model rather than here — this
 * component renders inside a Dialog portal, and the absent-versus-null rule is
 * the one piece of it whose failure is silent data loss.
 */

function enumOptions<TOption extends string>(
  options: ReadonlyArray<TOption>,
  labels: Record<TOption, string>,
) {
  return [
    { label: 'Не задано', value: NOT_SET },
    ...options.map((option) => ({ label: labels[option], value: option })),
  ]
}

export function DealEditDialog({
  assignableUsers = [],
  deal,
  isSaving,
  onSubmit,
}: {
  /** Empty while the roster loads, which the parent page has already requested. */
  assignableUsers?: ReadonlyArray<AssignableUserDto>
  deal: DealDetailDto
  isSaving: boolean
  onSubmit: (input: DealUpdateInput) => void
}) {
  const initial = toDealEditDraft(deal)
  const [isOpen, setIsOpen] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState(emptyFormErrors)

  const set = (field: keyof DealEditDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))

  const submit = () => {
    const built = buildDealUpdateInput(initial, draft)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }

    setErrors(emptyFormErrors)
    setIsOpen(false)
    onSubmit(built.value)
  }

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          <Typography variant="control">Редактировать</Typography>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Редактирование сделки</DialogTitle>
          <DialogDescription>
            Этап и оплаты меняются отдельным действием «Изменить этап».
          </DialogDescription>
        </DialogHeader>

        {errors.formMessage && (
          <Alert variant="destructive">
            <AlertTitle>Изменения не сохранены</AlertTitle>
            <AlertDescription>{errors.formMessage}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <CrmTextField
            error={errors.fields.name}
            label={DEAL_FIELD_LABELS.name}
            onChange={(value) => set('name', value)}
            value={draft.name}
          />
          <CrmTextField
            error={errors.fields.source}
            label={DEAL_FIELD_LABELS.source}
            onChange={(value) => set('source', value)}
            value={draft.source}
          />
          <CrmTextField
            error={errors.fields.form}
            label={DEAL_FIELD_LABELS.form}
            onChange={(value) => set('form', value)}
            value={draft.form}
          />
          <CrmTextField
            error={errors.fields.landingUrl}
            label={DEAL_FIELD_LABELS.landingUrl}
            onChange={(value) => set('landingUrl', value)}
            placeholder="https://teraso.com.ua/..."
            value={draft.landingUrl}
          />
          {/* Beside the other «Основное» fields of the card (PRD 7.1), so the
              dialog and the block it edits list them in the same order. */}
          <CrmSelectField
            error={errors.fields.responsibleUserId}
            label={DEAL_FIELD_LABELS.responsible}
            onChange={(value) => set('responsibleUserId', value)}
            options={assignableUserOptions(assignableUsers)}
            value={draft.responsibleUserId}
          />
          <CrmSelectField
            error={errors.fields.leadClass}
            label={DEAL_FIELD_LABELS.leadClass}
            onChange={(value) => set('leadClass', value)}
            options={enumOptions(leadClassSchema.options, LEAD_CLASS_LABELS)}
            value={draft.leadClass}
          />
          <CrmSelectField
            error={errors.fields.material}
            label={DEAL_FIELD_LABELS.material}
            onChange={(value) => set('material', value)}
            options={enumOptions(materialSchema.options, MATERIAL_LABELS)}
            value={draft.material}
          />
          <CrmTextField
            error={errors.fields.areaLabel}
            label={DEAL_FIELD_LABELS.areaLabel}
            onChange={(value) => set('areaLabel', value)}
            value={draft.areaLabel}
          />
          <CrmTextField
            error={errors.fields.budgetLabel}
            label={DEAL_FIELD_LABELS.budgetLabel}
            onChange={(value) => set('budgetLabel', value)}
            value={draft.budgetLabel}
          />
          <CrmTextField
            error={errors.fields.objectType}
            label={DEAL_FIELD_LABELS.objectType}
            onChange={(value) => set('objectType', value)}
            value={draft.objectType}
          />
          <CrmTextField
            error={errors.fields.needTiming}
            label={DEAL_FIELD_LABELS.needTiming}
            onChange={(value) => set('needTiming', value)}
            value={draft.needTiming}
          />
          <CrmSelectField
            error={errors.fields.preferredChannel}
            label={DEAL_FIELD_LABELS.preferredChannel}
            onChange={(value) => set('preferredChannel', value)}
            options={enumOptions(preferredChannelSchema.options, PREFERRED_CHANNEL_LABELS)}
            value={draft.preferredChannel}
          />
          <CrmTextField
            error={errors.fields.potentialAmount}
            inputMode="decimal"
            label={DEAL_FIELD_LABELS.potentialAmount}
            onChange={(value) => set('potentialAmount', value)}
            placeholder="65000.00"
            value={draft.potentialAmount}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          <Button disabled={isSaving} onClick={submit} type="button">
            <Typography variant="control">Сохранить</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
