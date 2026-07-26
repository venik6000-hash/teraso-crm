import {
  dealStageSchema,
  type DealDetailDto,
  type DealStage,
  type DealStageChangeInput,
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Typography } from '@/components/typography'
import { DEAL_STAGE_LABELS } from '../model'
import { emptyFormErrors } from '../validation'
import { CrmSelectField } from './CrmField'
import {
  StageCommitFields,
  buildStageChangeInput,
  emptyStageCommitDraft,
  type StageCommitDraft,
} from './StageCommitFields'

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
  const [draft, setDraft] = useState<StageCommitDraft>(() => emptyStageCommitDraft())
  const [errors, setErrors] = useState(emptyFormErrors)

  const options = dealStageSchema.options.filter((option) => option !== deal.stage)

  const submit = () => {
    if (!stage) {
      setErrors({ fields: { stage: 'Выберите этап' }, formMessage: null })
      return
    }

    // The payment and loss-reason fields are assembled by the same builder the
    // board's drop confirmation uses, so the two surfaces cannot drift.
    const built = buildStageChangeInput(stage, draft)
    if (!built.ok) {
      setErrors(built.errors)
      return
    }

    setErrors(emptyFormErrors)
    // Closed once the payload is valid: a rejection from the server is a fact
    // about the deal, so it belongs on the card next to the stage it names,
    // not hidden inside a dialog the owner has to reopen to read.
    setIsOpen(false)
    onChangeStage(built.value)
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

        {errors.formMessage && (
          <Alert variant="destructive">
            <AlertTitle>Этап не изменён</AlertTitle>
            <AlertDescription>{errors.formMessage}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4">
          <div data-testid="deal-stage-select">
            <CrmSelectField
              error={errors.fields.stage}
              label="Новый этап"
              onChange={(value) => {
                setStage(dealStageSchema.parse(value))
                setErrors(emptyFormErrors)
              }}
              options={options.map((option) => ({
                label: DEAL_STAGE_LABELS[option],
                value: option,
              }))}
              placeholder="Выберите этап"
              value={stage ?? undefined}
            />
          </div>

          {stage && (
            <StageCommitFields
              draft={draft}
              errors={errors}
              onChange={setDraft}
              stage={stage}
            />
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          {/*
            The test id names the ACTION rather than the control, so the same
            confirm button is addressable as «отметить предоплату» here and on
            the board's drop dialog — one selector per business step instead of
            one per surface.
          */}
          <Button
            data-testid={
              stage === 'PREPAYMENT' ? 'mark-prepayment' : stage === 'WON' ? 'mark-won' : undefined
            }
            disabled={isSaving}
            onClick={submit}
            type="button"
          >
            <Typography variant="control">Сохранить этап</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
