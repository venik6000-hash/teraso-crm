import {
  dealStageChangeSchema,
  dealStageSchema,
  lossReasonSchema,
  type DealDetailDto,
  type DealStage,
  type DealStageChangeInput,
  type LossReason,
} from '@teraso-crm/contracts'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
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
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/typography'
import {
  DEAL_STAGE_LABELS,
  LOSS_REASON_LABELS,
  dealFormFieldErrors,
  toInstantFromKyivInput,
  toKyivDateTimeInput,
} from '../model'

/**
 * Moves a deal through the funnel from the card (PRD 7.3).
 *
 * Every stage except the current one is offered and the server decides which
 * moves are legal: the reachable-stage graph is server-authoritative and is
 * deliberately not mirrored here, so the browser cannot drift from it. An
 * illegal move comes back as a Russian rejection and is shown on the card.
 *
 * Reopening a closed deal is a separate, confirmed action rather than one more
 * entry in the list, because it is an administrative correction that always
 * leaves a record in the history.
 */
export function DealStageDialog({
  deal,
  isSaving,
  onChangeStage,
}: {
  deal: DealDetailDto
  isSaving: boolean
  onChangeStage: (input: DealStageChangeInput) => void
}) {
  const isClosed = deal.stage === 'WON' || deal.stage === 'LOST'

  return (
    <>
      <StageChangeDialog deal={deal} isSaving={isSaving} onChangeStage={onChangeStage} />
      {isClosed && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" type="button" variant="outline">
              <Typography variant="control">Переоткрыть</Typography>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Переоткрыть сделку?</AlertDialogTitle>
              <AlertDialogDescription>
                Сделка вернётся на этап «Новая заявка», причина потери будет снята,
                а событие останется в ленте.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                disabled={isSaving}
                onClick={() => onChangeStage({ stage: 'NEW', lossReason: null })}
              >
                Переоткрыть
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}

function StageChangeDialog({
  deal,
  isSaving,
  onChangeStage,
}: {
  deal: DealDetailDto
  isSaving: boolean
  onChangeStage: (input: DealStageChangeInput) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [stage, setStage] = useState<DealStage | null>(null)
  const [lossReason, setLossReason] = useState<LossReason | null>(null)
  const [comment, setComment] = useState('')
  const [amount, setAmount] = useState('')
  const [paidAt, setPaidAt] = useState(toKyivDateTimeInput(new Date().toISOString()))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const options = dealStageSchema.options.filter((option) => option !== deal.stage)
  const needsPrepayment = stage === 'PREPAYMENT'
  const needsFullPayment = stage === 'WON'
  const needsLossReason = stage === 'LOST'

  const submit = () => {
    if (!stage) {
      setErrors({ stage: 'Выберите этап' })
      return
    }

    const payload: Record<string, unknown> = { stage }
    if (comment.trim()) payload.comment = comment.trim()
    if (needsLossReason) payload.lossReason = lossReason ?? undefined
    if (needsPrepayment) {
      payload.prepaymentAmount = amount.trim()
      payload.prepaymentPaidAt = toInstantFromKyivInput(paidAt)
    }
    if (needsFullPayment) {
      payload.fullPaymentAmount = amount.trim()
      payload.fullPaymentPaidAt = toInstantFromKyivInput(paidAt)
    }

    const parsed = dealStageChangeSchema.safeParse(payload)
    if (!parsed.success) {
      setErrors(dealFormFieldErrors(parsed.error.issues))
      return
    }

    setErrors({})
    // Closed once the payload is valid: a rejection from the server is a fact
    // about the deal, so it belongs on the card next to the stage it names,
    // not hidden inside a dialog the owner has to reopen to read.
    setIsOpen(false)
    onChangeStage(parsed.data)
  }

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger asChild>
        <Button size="sm" type="button">
          <Typography variant="control">Изменить этап</Typography>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Изменение этапа</DialogTitle>
          <DialogDescription>
            {`Сейчас: ${DEAL_STAGE_LABELS[deal.stage]}. Правила воронки проверяет сервер.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="stage-target">Новый этап</Label>
            <Select
              onValueChange={(value) => {
                setStage(dealStageSchema.parse(value))
                setErrors({})
              }}
              value={stage ?? undefined}
            >
              <SelectTrigger id="stage-target">
                <SelectValue placeholder="Выберите этап" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {DEAL_STAGE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.stage} />
          </div>

          {needsLossReason && (
            <div className="grid gap-2">
              <Label htmlFor="stage-loss-reason">Причина потери</Label>
              <Select
                onValueChange={(value) => setLossReason(lossReasonSchema.parse(value))}
                value={lossReason ?? undefined}
              >
                <SelectTrigger id="stage-loss-reason">
                  <SelectValue placeholder="Выберите причину" />
                </SelectTrigger>
                <SelectContent>
                  {lossReasonSchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {LOSS_REASON_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.lossReason} />
            </div>
          )}

          {(needsPrepayment || needsFullPayment) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="stage-amount">
                  {needsPrepayment ? 'Сумма предоплаты' : 'Сумма полной оплаты'}
                </Label>
                <Input
                  id="stage-amount"
                  inputMode="decimal"
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="65000.00"
                  value={amount}
                />
                <FieldError
                  message={errors.prepaymentAmount ?? errors.fullPaymentAmount}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="stage-paid-at">Дата оплаты</Label>
                <Input
                  id="stage-paid-at"
                  onChange={(event) => setPaidAt(event.target.value)}
                  type="datetime-local"
                  value={paidAt}
                />
                <FieldError
                  message={errors.prepaymentPaidAt ?? errors.fullPaymentPaidAt}
                />
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="stage-comment">Комментарий в ленту</Label>
            <Textarea
              id="stage-comment"
              maxLength={4000}
              onChange={(event) => setComment(event.target.value)}
              rows={2}
              value={comment}
            />
            <FieldError message={errors.comment} />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          <Button disabled={isSaving} onClick={submit} type="button">
            <Typography variant="control">Сохранить этап</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <Typography role="alert" variant="caption" tone="destructive">
      {message}
    </Typography>
  )
}
