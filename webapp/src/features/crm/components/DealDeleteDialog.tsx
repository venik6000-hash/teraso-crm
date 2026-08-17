import type { DealDetailDto } from '@teraso-crm/contracts'

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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Typography } from '@/components/typography'
import { formatMoney, formatPhone, recordedPaymentAmount } from '../model'

/**
 * Erases a deal permanently.
 *
 * This is the one action in the CRM with no way back. Every other terminal move
 * — closing as lost, archiving — leaves the deal readable and reopenable, and
 * the archive exists precisely so that «убрать с глаз» does not have to mean
 * «стереть». So this dialog spells out what disappears rather than asking a bare
 * «Вы уверены?», and it names the client and the number so the owner can see
 * they are about to delete the deal they think they are.
 *
 * A deal that recorded money gets a second, louder warning. Received payments
 * are attributed by their own date, so erasing a paid deal silently lowers a
 * past period's reported revenue — a consequence nobody deduces from the word
 * «удалить», and the only one here that reaches beyond this card.
 *
 * Rendered already open and closed by its caller, exactly as `StageCommitDialog`
 * is. The trigger stays on the card, which leaves this component a pure function
 * of the deal — so what it actually says can be asserted directly, rather than
 * only through a click a static render never performs.
 */
export function DealDeleteDialog({
  deal,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  deal: DealDetailDto
  isDeleting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const recordedPayment = recordedPaymentAmount(deal)

  return (
    <AlertDialog onOpenChange={(open) => !open && onCancel()} open>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить заявку без возможности восстановления?</AlertDialogTitle>
          <AlertDialogDescription>
            {`${deal.client.name}, ${formatPhone(deal.client.phoneNormalized)}. Будут стёрты сама
            заявка, все её задачи, вся лента событий и данные о том, откуда она пришла. Отменить это
            нельзя, и «Переоткрыть» здесь уже не поможет.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {recordedPayment && (
          <Alert variant="destructive">
            <AlertTitle>Заявка с оплатой</AlertTitle>
            <AlertDescription>
              {`По ней проведено ${formatMoney(recordedPayment)}. Эти деньги пропадут из отчётов за
              тот период, когда они пришли. Если нужно просто убрать заявку с доски — выберите
              «Архив», там всё сохранится.`}
            </AlertDescription>
          </Alert>
        )}

        <Typography tone="muted" variant="caption">
          Карточка клиента и его другие заявки останутся на месте.
        </Typography>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            data-testid="delete-deal"
            disabled={isDeleting}
            onClick={onConfirm}
            variant="destructive"
          >
            Удалить навсегда
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
