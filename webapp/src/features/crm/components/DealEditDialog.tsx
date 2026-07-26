import {
  dealUpdateSchema,
  leadClassSchema,
  materialSchema,
  preferredChannelSchema,
  type DealDetailDto,
  type DealUpdateInput,
} from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Typography } from '@/components/typography'
import {
  DEAL_FIELD_LABELS,
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  PREFERRED_CHANNEL_LABELS,
  dealFormFieldErrors,
} from '../model'

/**
 * Edits the working fields of a deal (PRD 7.1: «Все поля редактируемы»).
 *
 * Stage, payment fields and the loss reason are deliberately absent — they move
 * only through the funnel action, so a field edit cannot bypass the rules or
 * hand a deal a payment date it never earned.
 *
 * Only changed fields are sent: an untouched key leaves the stored value alone
 * and an emptied optional field is sent as an explicit `null` to clear it.
 */

/** Radix `Select` cannot carry an empty value, so "not set" needs a sentinel. */
const NOT_SET = '__not_set__'

type DraftState = {
  name: string
  source: string
  form: string
  landingUrl: string
  leadClass: string
  material: string
  areaLabel: string
  budgetLabel: string
  objectType: string
  needTiming: string
  preferredChannel: string
  potentialAmount: string
}

function toDraft(deal: DealDetailDto): DraftState {
  return {
    name: deal.client.name,
    source: deal.source,
    form: deal.form ?? '',
    landingUrl: deal.landingUrl ?? '',
    leadClass: deal.leadClass ?? NOT_SET,
    material: deal.material ?? NOT_SET,
    areaLabel: deal.areaLabel ?? '',
    budgetLabel: deal.budgetLabel ?? '',
    objectType: deal.objectType ?? '',
    needTiming: deal.needTiming ?? '',
    preferredChannel: deal.preferredChannel ?? NOT_SET,
    potentialAmount: deal.potentialAmount ?? '',
  }
}

export function DealEditDialog({
  deal,
  isSaving,
  onSubmit,
}: {
  deal: DealDetailDto
  isSaving: boolean
  onSubmit: (input: DealUpdateInput) => void
}) {
  const initial = toDraft(deal)
  const [isOpen, setIsOpen] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const set = (field: keyof DraftState, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }))

  const submit = () => {
    const changed: Record<string, unknown> = {}
    for (const key of Object.keys(initial) as Array<keyof DraftState>) {
      if (draft[key] === initial[key]) continue
      const value = draft[key].trim()
      changed[key] = value === '' || value === NOT_SET ? null : value
    }

    if (Object.keys(changed).length === 0) {
      setErrors({ _form: 'Изменений нет' })
      return
    }

    const parsed = dealUpdateSchema.safeParse(changed)
    if (!parsed.success) {
      setErrors(dealFormFieldErrors(parsed.error.issues))
      return
    }

    setErrors({})
    setIsOpen(false)
    onSubmit(parsed.data)
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

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            error={errors.name}
            id="deal-name"
            label={DEAL_FIELD_LABELS.name}
            onChange={(value) => set('name', value)}
            value={draft.name}
          />
          <TextField
            error={errors.source}
            id="deal-source"
            label={DEAL_FIELD_LABELS.source}
            onChange={(value) => set('source', value)}
            value={draft.source}
          />
          <TextField
            error={errors.form}
            id="deal-form"
            label={DEAL_FIELD_LABELS.form}
            onChange={(value) => set('form', value)}
            value={draft.form}
          />
          <TextField
            error={errors.landingUrl}
            id="deal-landing-url"
            label={DEAL_FIELD_LABELS.landingUrl}
            onChange={(value) => set('landingUrl', value)}
            placeholder="https://teraso.com.ua/..."
            value={draft.landingUrl}
          />
          <EnumField
            error={errors.leadClass}
            id="deal-lead-class"
            label={DEAL_FIELD_LABELS.leadClass}
            labels={LEAD_CLASS_LABELS}
            onChange={(value) => set('leadClass', value)}
            options={leadClassSchema.options}
            value={draft.leadClass}
          />
          <EnumField
            error={errors.material}
            id="deal-material"
            label={DEAL_FIELD_LABELS.material}
            labels={MATERIAL_LABELS}
            onChange={(value) => set('material', value)}
            options={materialSchema.options}
            value={draft.material}
          />
          <TextField
            error={errors.areaLabel}
            id="deal-area"
            label={DEAL_FIELD_LABELS.areaLabel}
            onChange={(value) => set('areaLabel', value)}
            value={draft.areaLabel}
          />
          <TextField
            error={errors.budgetLabel}
            id="deal-budget"
            label={DEAL_FIELD_LABELS.budgetLabel}
            onChange={(value) => set('budgetLabel', value)}
            value={draft.budgetLabel}
          />
          <TextField
            error={errors.objectType}
            id="deal-object-type"
            label={DEAL_FIELD_LABELS.objectType}
            onChange={(value) => set('objectType', value)}
            value={draft.objectType}
          />
          <TextField
            error={errors.needTiming}
            id="deal-need-timing"
            label={DEAL_FIELD_LABELS.needTiming}
            onChange={(value) => set('needTiming', value)}
            value={draft.needTiming}
          />
          <EnumField
            error={errors.preferredChannel}
            id="deal-channel"
            label={DEAL_FIELD_LABELS.preferredChannel}
            labels={PREFERRED_CHANNEL_LABELS}
            onChange={(value) => set('preferredChannel', value)}
            options={preferredChannelSchema.options}
            value={draft.preferredChannel}
          />
          <TextField
            error={errors.potentialAmount}
            id="deal-potential-amount"
            inputMode="decimal"
            label={DEAL_FIELD_LABELS.potentialAmount}
            onChange={(value) => set('potentialAmount', value)}
            placeholder="65000.00"
            value={draft.potentialAmount}
          />
        </div>

        {errors._form && (
          <Typography role="alert" variant="caption" tone="destructive">
            {errors._form}
          </Typography>
        )}

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

function TextField({
  error,
  id,
  inputMode,
  label,
  onChange,
  placeholder,
  value,
}: {
  error?: string
  id: string
  inputMode?: 'decimal'
  label: string
  onChange: (value: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <FieldShell error={error} id={id} label={label}>
      <Input
        aria-invalid={error ? true : undefined}
        id={id}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </FieldShell>
  )
}

function EnumField<TOption extends string>({
  error,
  id,
  label,
  labels,
  onChange,
  options,
  value,
}: {
  error?: string
  id: string
  label: string
  labels: Record<TOption, string>
  onChange: (value: string) => void
  options: ReadonlyArray<TOption>
  value: string
}) {
  return (
    <FieldShell error={error} id={id} label={label}>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SET}>Не задано</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
}

function FieldShell({
  children,
  error,
  id,
  label,
}: {
  children: ReactNode
  error?: string
  id: string
  label: string
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <Typography role="alert" variant="caption" tone="destructive">
          {error}
        </Typography>
      )}
    </div>
  )
}
