import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  dealStageSchema,
  type DealBoardResponse,
  type DealStage,
  type DealSummaryDto,
} from '@teraso-crm/contracts'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Typography } from '@/components/typography'
import { DEAL_STAGE_LABELS, boardDropIntent, type BoardDropIntent } from '../model'
import { DealBoardCard } from './DealBoardCard'

/**
 * The Kanban board (PRD 7.6).
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. **No optimistic move.** Columns are rendered straight from the server
 *    response, so a card appears in its new column only once the API has
 *    accepted the move. That is what makes "the card returns to its column on
 *    cancel or server rejection" true by construction rather than by an undo
 *    path that has to be remembered — including for the 400 «Недопустимый
 *    переход» that a racing second drag receives from the per-deal advisory
 *    lock.
 * 2. **No mirrored funnel graph.** Every drop is offered to the server; the
 *    board only decides which confirmation to open first (see `boardDropIntent`).
 *
 * Dragging is wired with pointer, touch and keyboard sensors so the board is
 * usable with a mouse, on a phone and from the keyboard. On a phone the columns
 * scroll horizontally as a deliberate exception to PRD 10 — a board IS a
 * horizontal object — while every card inside a column stays full width, and the
 * list at `/app/deals` remains the one-handed surface.
 */

/** The loss zone is a drop target, never a column: LOST has no board column. */
const LOSS_DROP_ID = 'stage:LOST'
const dropIdFor = (stage: DealStage) => `stage:${stage}`

export function DealBoard({
  board,
  onDrop,
  pendingMove = null,
}: {
  board: DealBoardResponse
  onDrop?: (deal: DealSummaryDto, intent: BoardDropIntent) => void
  /** The move awaiting confirmation, shown as a hint — never as a moved card. */
  pendingMove?: { dealId: string; stage: DealStage } | null
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const dealsById = new Map(
    board.columns.flatMap((column) => column.deals.map((deal) => [deal.id, deal] as const)),
  )

  const sensors = useSensors(
    // A small distance threshold keeps a tap on the card's link from starting a
    // drag, which is the difference between a usable board and an unusable one
    // on a touchscreen.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  )

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null)
    const deal = dealsById.get(String(event.active.id))
    const target = toStage(event.over?.id)
    if (!deal || !target || !onDrop) return
    onDrop(deal, boardDropIntent(deal.stage, target))
  }

  return (
    <DndContext
      onDragCancel={() => setDraggingId(null)}
      onDragEnd={handleDragEnd}
      onDragStart={(event: DragStartEvent) => setDraggingId(String(event.active.id))}
      sensors={sensors}
    >
      <div className="grid gap-4">
        <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
          {board.columns.map((column) => (
            <BoardColumn
              column={column}
              draggingId={draggingId}
              key={column.stage}
              pendingMove={pendingMove}
            />
          ))}
        </div>

        <LossDropZone />
      </div>

      <DragOverlay>
        {draggingId && dealsById.has(draggingId) ? (
          <DealBoardCard deal={dealsById.get(draggingId)!} isDragging />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function BoardColumn({
  column,
  draggingId,
  pendingMove,
}: {
  column: DealBoardResponse['columns'][number]
  draggingId: string | null
  pendingMove: { dealId: string; stage: DealStage } | null
}) {
  const { isOver, setNodeRef } = useDroppable({ id: dropIdFor(column.stage) })

  return (
    <section
      className={`w-72 shrink-0 snap-start rounded-xl border p-3 ${
        isOver ? 'ring-2 ring-primary' : ''
      }`}
      ref={setNodeRef}
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <Typography variant="control">{DEAL_STAGE_LABELS[column.stage]}</Typography>
        {/* The count is a number and a label, so the column header is not a
            colour-coded blob (PRD 7.0). */}
        <Badge variant="secondary">
          <Typography variant="controlXs">{`${column.totalCount} шт.`}</Typography>
        </Badge>
      </header>

      <div className="grid gap-2">
        {column.deals.map((deal) => (
          <DraggableCard
            deal={deal}
            isDragging={draggingId === deal.id}
            isPending={pendingMove?.dealId === deal.id}
            key={deal.id}
          />
        ))}
        {column.deals.length === 0 && (
          <Typography tone="muted" variant="caption">
            Пусто
          </Typography>
        )}
      </div>
    </section>
  )
}

function DraggableCard({
  deal,
  isDragging,
  isPending,
}: {
  deal: DealSummaryDto
  isDragging: boolean
  isPending: boolean
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: deal.id })

  return (
    <div ref={setNodeRef}>
      {/*
        A pending move is announced in words beside the card that has NOT moved,
        which is the honest rendering: the deal is still in this column until the
        server says otherwise.
      */}
      {isPending && (
        <Typography tone="muted" variant="caption">
          Переносим…
        </Typography>
      )}
      <DealBoardCard
        deal={deal}
        dragHandle={{ ...attributes, ...listeners }}
        isDragging={isDragging}
      />
    </div>
  )
}

/**
 * The loss zone (PRD 7.3): lost deals do not occupy a funnel column, so closing
 * one is a separate target below the board rather than a sixth column that would
 * read as a stage of the funnel.
 */
function LossDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: LOSS_DROP_ID })

  return (
    <div
      className={`rounded-xl border border-dashed p-4 text-center ${
        isOver ? 'ring-2 ring-destructive' : ''
      }`}
      ref={setNodeRef}
    >
      <Typography variant="control">Потеряна</Typography>
      <Typography tone="muted" variant="caption">
        Перетащите сюда, чтобы закрыть сделку без продажи — понадобится причина.
      </Typography>
    </div>
  )
}

/** Droppable ids are `stage:<STAGE>`; anything else is not a board target. */
function toStage(id: string | number | undefined): DealStage | null {
  if (typeof id !== 'string' || !id.startsWith('stage:')) return null
  const parsed = dealStageSchema.safeParse(id.slice('stage:'.length))
  return parsed.success ? parsed.data : null
}
