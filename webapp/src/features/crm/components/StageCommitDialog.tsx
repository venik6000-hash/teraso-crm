import type { DealStage, DealStageChangeInput, DealSummaryDto } from '@teraso-crm/contracts'
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
} from '@/components/ui/dialog'
import { Typography } from '@/components/typography'
import { DEAL_STAGE_LABELS } from '../model'
import { emptyFormErrors } from '../validation'
import {
  StageCommitFields,
  buildStageChangeInput,
  emptyStageCommitDraft,
  type StageCommitDraft,
} from './StageCommitFields'

/**
 * Confirms a stage move started by dragging a card (PRD 7.3, 7.6).
 *
 * Cancelling simply closes this dialog. There is nothing to undo, because the
 * board never moved the card: columns render from the server response, so a deal
 * is only ever drawn in the stage the API says it is in.
 *
 * Closing as lost uses `AlertDialog` rather than `Dialog` — it is the
 * destructive, effectively irreversible action of the funnel (reopening is an
 * administrative correction that leaves a permanent record), and PRD 7.0 asks
 * for explicit confirmation of exactly those.
 */
export function StageCommitDialog({
  deal,
  isPending = false,
  onCancel,
  onConfirm,
  stage,
}: {
  deal: DealSummaryDto
  isPending?: boolean
  onCancel: () => void
  onConfirm: (input: DealStageChangeInput) => void
  stage: DealStage
}) {
  const [draft, setDraft] = useState<StageCommitDraft>(() => emptyStageCommitDraft())
  const [errors, setErrors] = useState(emptyFormErrors)

  const submit = () => {
    const built = buildStageChangeInput(stage, draft)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }
    setErrors(emptyFormErrors)
    onConfirm(built.value)
  }

  const title = `${deal.client.name} → ${DEAL_STAGE_LABELS[stage]}`
  const fields = (
    <StageCommitFields draft={draft} errors={errors} onChange={setDraft} stage={stage} />
  )
  const close = (open: boolean) => {
    if (!open) onCancel()
  }

  if (stage === 'LOST') {
    return (
      <AlertDialog onOpenChange={close} open>
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Закрыть сделку как потерянную?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${deal.client.name}. Сделка перестанет требовать следующего шага и останется в
              истории клиента. Причина обязательна, комментарий сохранится в ленте.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {fields}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancel}>Отмена</AlertDialogCancel>
            {/*
              `onSelect` is prevented so a failed validation keeps the dialog
              open: the default action closes it, which would discard the
              message explaining what is missing.
            */}
            <AlertDialogAction
              disabled={isPending}
              onClick={submit}
              onSelect={(event) => event.preventDefault()}
            >
              Закрыть как потерянную
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <Dialog onOpenChange={close} open>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {stage === 'PREPAYMENT'
              ? 'Для предоплаты обязательны сумма и дата — сделка остаётся открытой.'
              : stage === 'WON'
                ? 'Для успеха обязательны сумма и дата полной оплаты.'
                : 'Правила воронки проверяет сервер.'}
          </DialogDescription>
        </DialogHeader>

        {fields}

        <DialogFooter>
          <DialogClose asChild>
            <Button onClick={onCancel} type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          <Button
            data-testid={stage === 'PREPAYMENT' ? 'mark-prepayment' : stage === 'WON' ? 'mark-won' : undefined}
            disabled={isPending}
            onClick={submit}
            type="button"
          >
            <Typography variant="control">Подтвердить</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
