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
 * Closing as lost and archiving both use `AlertDialog` rather than `Dialog` —
 * they are the terminal moves of the funnel, taking a deal off the board in one
 * gesture, and PRD 7.0 asks for explicit confirmation of exactly those. Neither
 * is irreversible: reopening is an administrative correction that leaves a
 * permanent record, and each dialog says so rather than implying finality it
 * does not have. (The genuinely irreversible action is deletion, which lives on
 * the card and never on a drag.)
 */
/**
 * The two terminal destinations and the words each one confirms with.
 *
 * They are worded apart on purpose. A loss is an OUTCOME — it needs a reason and
 * it feeds the loss breakdown — while an archive is a DECISION ABOUT ATTENTION
 * and records nothing about why the deal ended. A shared "are you sure?" would
 * blur exactly the distinction the funnel depends on.
 */
const TERMINAL_CONFIRMATIONS = {
  LOST: {
    title: 'Закрыть сделку как потерянную?',
    description:
      'Сделка перестанет требовать следующего шага и останется в истории клиента. Причина обязательна, комментарий сохранится в ленте.',
    confirm: 'Закрыть как потерянную',
    testId: 'mark-lost',
  },
  ARCHIVED: {
    title: 'Убрать сделку в архив?',
    description:
      'Сделка уйдёт с доски и перестанет требовать следующего шага. Ничего не удаляется: суммы, задачи и лента событий останутся на месте, найти её можно фильтром «Этап: Архив», а вернуть — кнопкой «Переоткрыть».',
    confirm: 'В архив',
    testId: 'mark-archived',
  },
} as const

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

  const terminal = TERMINAL_CONFIRMATIONS[stage as 'LOST' | 'ARCHIVED']
  if (terminal) {
    return (
      <AlertDialog onOpenChange={close} open>
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{terminal.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {`${deal.client.name}. ${terminal.description}`}
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
              data-testid={terminal.testId}
              disabled={isPending}
              onClick={submit}
              onSelect={(event) => event.preventDefault()}
            >
              {terminal.confirm}
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
