import {
  BringToFrontIcon,
  GripIcon,
  LoaderCircleIcon,
  Repeat2Icon,
  RotateCcwIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react"
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"

import { CoverImagePreview } from "~/components/shared/cover-image-preview"
import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog"
import { Button } from "~/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import type { FudabaCardPlacement, FudabaPlacedCard } from "~/lib/api"
import { cn } from "~/lib/utils"

export type WallPlacement = Pick<
  FudabaCardPlacement,
  "x" | "y" | "rotation" | "zIndex"
>

type PlacementCommit = (
  cardId: string,
  previous: FudabaCardPlacement,
  placement: WallPlacement
) => void

interface PlacedCardWallProps {
  cards: FudabaPlacedCard[]
  editing?: boolean
  pendingCardIds?: ReadonlySet<string>
  onPlacementPreview?: (cardId: string, placement: WallPlacement) => void
  onPlacementCommit?: PlacementCommit
  onRemove?: (card: FudabaPlacedCard) => void
}

interface WallCardProps {
  board: HTMLDivElement | null
  card: FudabaPlacedCard
  editing: boolean
  flipped: boolean
  pending: boolean
  selected: boolean
  onFlip: () => void
  onSelect: () => void
  onPlacementPreview?: PlacedCardWallProps["onPlacementPreview"]
  onPlacementCommit?: PlacementCommit
}

interface DragStart {
  pointerId: number
  clientX: number
  clientY: number
  placement: FudabaCardPlacement
  latest: WallPlacement
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function roundedCoordinate(value: number) {
  return Math.round(clamp(value, 0, 100) * 10) / 10
}

function placementFields(placement: FudabaCardPlacement): WallPlacement {
  return {
    x: placement.x,
    y: placement.y,
    rotation: placement.rotation,
    zIndex: placement.zIndex,
  }
}

function samePlacement(left: WallPlacement, right: WallPlacement) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.rotation === right.rotation &&
    left.zIndex === right.zIndex
  )
}

function compareCardStacking(left: FudabaPlacedCard, right: FudabaPlacedCard) {
  const zIndexDifference = left.placement.zIndex - right.placement.zIndex
  if (zIndexDifference !== 0) return zIndexDifference

  const updatedAtDifference =
    Date.parse(left.placement.updatedAt) - Date.parse(right.placement.updatedAt)
  if (updatedAtDifference !== 0) return updatedAtDifference

  return left.id.localeCompare(right.id)
}

function IconTooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function WallCard({
  board,
  card,
  editing,
  flipped,
  pending,
  selected,
  onFlip,
  onSelect,
  onPlacementPreview,
  onPlacementCommit,
}: WallCardProps) {
  const dragStart = useRef<DragStart | null>(null)
  const cardElement = useRef<HTMLDivElement | null>(null)
  const canMove = editing && card.viewerOwned && !pending

  function preview(placement: WallPlacement) {
    onPlacementPreview?.(card.id, placement)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!canMove || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const placement = card.placement
    dragStart.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      placement,
      latest: placementFields(placement),
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStart.current
    if (!start || start.pointerId !== event.pointerId || !board) return
    const bounds = board.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const next = {
      ...start.latest,
      x: roundedCoordinate(
        start.placement.x +
          ((event.clientX - start.clientX) / bounds.width) * 100
      ),
      y: roundedCoordinate(
        start.placement.y +
          ((event.clientY - start.clientY) / bounds.height) * 100
      ),
    }
    start.latest = next
    if (cardElement.current) {
      cardElement.current.style.left =
        `clamp(var(--wall-x-inset), ${next.x}%, ` +
        "calc(100% - var(--wall-x-inset)))"
      cardElement.current.style.top =
        `clamp(var(--wall-y-inset), ${next.y}%, ` +
        "calc(100% - var(--wall-y-inset)))"
      cardElement.current.dataset.placementX = String(next.x)
      cardElement.current.dataset.placementY = String(next.y)
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    dragStart.current = null
    onSelect()
    if (!samePlacement(placementFields(start.placement), start.latest)) {
      preview(start.latest)
      onPlacementCommit?.(card.id, start.placement, start.latest)
    }
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStart.current
    if (!start || start.pointerId !== event.pointerId) return
    dragStart.current = null
    const previous = placementFields(start.placement)
    if (cardElement.current) {
      cardElement.current.style.left =
        `clamp(var(--wall-x-inset), ${previous.x}%, ` +
        "calc(100% - var(--wall-x-inset)))"
      cardElement.current.style.top =
        `clamp(var(--wall-y-inset), ${previous.y}%, ` +
        "calc(100% - var(--wall-y-inset)))"
      cardElement.current.dataset.placementX = String(previous.x)
      cardElement.current.dataset.placementY = String(previous.y)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!canMove) return
    const step = event.shiftKey ? 5 : 1
    const movement = {
      ArrowDown: [0, step],
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
    }[event.key]
    if (!movement) return
    event.preventDefault()
    onSelect()
    const previous = card.placement
    const next = {
      ...placementFields(previous),
      x: roundedCoordinate(previous.x + movement[0]),
      y: roundedCoordinate(previous.y + movement[1]),
    }
    if (samePlacement(placementFields(previous), next)) return
    preview(next)
    onPlacementCommit?.(card.id, previous, next)
  }

  const side = flipped ? "背面" : "正面"

  return (
    <div
      ref={cardElement}
      className={cn(
        "absolute w-[clamp(7rem,18vw,13rem)]",
        "[--wall-x-inset:4.5rem] [--wall-y-inset:3.5rem]",
        "sm:[--wall-x-inset:7.5rem] sm:[--wall-y-inset:6rem]",
        selected && "ring-2 ring-primary ring-offset-2 ring-offset-background"
      )}
      data-card-id={card.id}
      data-placement-x={card.placement.x}
      data-placement-y={card.placement.y}
      style={{
        left: `clamp(var(--wall-x-inset), ${card.placement.x}%, calc(100% - var(--wall-x-inset)))`,
        top: `clamp(var(--wall-y-inset), ${card.placement.y}%, calc(100% - var(--wall-y-inset)))`,
        zIndex: card.placement.zIndex,
        transform: `translate(-50%, -50%) rotate(${card.placement.rotation}deg)`,
      }}
    >
      <CoverImagePreview
        src={flipped ? card.backImageUrl : card.frontImageUrl}
        alt={`${card.displayName}${side}`}
        previewLabel="名片"
        className="aspect-3/2 w-full border bg-card shadow-sm"
        imageClassName="object-contain"
      />
      <IconTooltip label={flipped ? "翻到正面" : "翻到背面"}>
        <Button
          type="button"
          variant="secondary"
          size="icon-xs"
          className="absolute right-1.5 bottom-1.5 shadow-sm"
          aria-label={`${card.displayName}${flipped ? "翻到正面" : "翻到背面"}`}
          onClick={onFlip}
        >
          <Repeat2Icon aria-hidden="true" />
        </Button>
      </IconTooltip>
      {editing && card.viewerOwned ? (
        <IconTooltip label="移动名片">
          <Button
            type="button"
            variant={selected ? "default" : "outline"}
            size="icon-sm"
            className={cn(
              "absolute -top-3 -left-3 touch-none shadow-sm",
              canMove && "cursor-grab active:cursor-grabbing"
            )}
            aria-label={`移动${card.displayName}`}
            aria-pressed={selected}
            disabled={pending}
            onFocus={onSelect}
            onKeyDown={handleKeyDown}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {pending ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <GripIcon aria-hidden="true" />
            )}
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  )
}

export function PlacedCardWall({
  cards,
  editing = false,
  pendingCardIds = new Set<string>(),
  onPlacementPreview,
  onPlacementCommit,
  onRemove,
}: PlacedCardWallProps) {
  const [board, setBoard] = useState<HTMLDivElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flippedIds, setFlippedIds] = useState(() => new Set<string>())
  const [removeOpen, setRemoveOpen] = useState(false)

  const ownedCards = useMemo(
    () => cards.filter((card) => card.viewerOwned),
    [cards]
  )
  const orderedCards = useMemo(
    () => [...cards].sort(compareCardStacking),
    [cards]
  )
  const selectedCard = editing
    ? (ownedCards.find((card) => card.id === selectedId) ??
      ownedCards[0] ??
      null)
    : null
  const selectedPending = selectedCard
    ? pendingCardIds.has(selectedCard.id)
    : false
  const maximumZIndex = Math.max(
    0,
    ...cards.map((card) => card.placement.zIndex)
  )
  const selectedIsFrontmost =
    selectedCard !== null && orderedCards.at(-1)?.id === selectedCard.id

  function flip(cardId: string) {
    setFlippedIds((current) => {
      const next = new Set(current)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  function commitSelected(patch: Partial<WallPlacement>) {
    if (!selectedCard || selectedPending) return
    const previous = selectedCard.placement
    const next = { ...placementFields(previous), ...patch }
    if (samePlacement(placementFields(previous), next)) return
    onPlacementPreview?.(selectedCard.id, next)
    onPlacementCommit?.(selectedCard.id, previous, next)
  }

  function bringSelectedToFront() {
    if (!selectedCard || selectedPending || selectedIsFrontmost) return
    const previous = selectedCard.placement
    const next = {
      ...placementFields(previous),
      zIndex: Math.min(999, maximumZIndex + 1),
    }
    if (!samePlacement(placementFields(previous), next)) {
      onPlacementPreview?.(selectedCard.id, next)
    }
    onPlacementCommit?.(selectedCard.id, previous, next)
  }

  return (
    <TooltipProvider>
      <div
        ref={setBoard}
        className={cn(
          "relative min-h-96 overflow-hidden border bg-muted/40",
          "sm:aspect-video sm:min-h-0",
          editing && "border-primary/35 bg-muted/55"
        )}
        aria-label="名片墙放置区域"
        aria-busy={pendingCardIds.size > 0}
      >
        <SeriesAccentStrip className="absolute inset-x-0 top-0 z-1001 h-1" />

        {editing ? (
          <div
            role="toolbar"
            aria-label="名片墙编辑工具"
            className={cn(
              "absolute top-3 left-1/2 z-1002 flex max-w-[calc(100%-1.5rem)]",
              "-translate-x-1/2 items-center gap-1 border bg-background/95",
              "px-1.5 py-1 shadow-sm backdrop-blur"
            )}
          >
            <span className="max-w-28 truncate px-1 text-xs font-medium sm:max-w-48">
              {selectedCard?.displayName ?? "选择名片"}
            </span>
            <IconTooltip label="向左旋转">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="向左旋转名片"
                disabled={!selectedCard || selectedPending}
                onClick={() =>
                  commitSelected({
                    rotation: clamp(
                      (selectedCard?.placement.rotation ?? 0) - 2,
                      -12,
                      12
                    ),
                  })
                }
              >
                <RotateCcwIcon aria-hidden="true" />
              </Button>
            </IconTooltip>
            <IconTooltip label="向右旋转">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="向右旋转名片"
                disabled={!selectedCard || selectedPending}
                onClick={() =>
                  commitSelected({
                    rotation: clamp(
                      (selectedCard?.placement.rotation ?? 0) + 2,
                      -12,
                      12
                    ),
                  })
                }
              >
                <RotateCwIcon aria-hidden="true" />
              </Button>
            </IconTooltip>
            <IconTooltip label="移到最前">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="将名片移到最前"
                disabled={
                  !selectedCard || selectedPending || selectedIsFrontmost
                }
                onClick={bringSelectedToFront}
              >
                <BringToFrontIcon aria-hidden="true" />
              </Button>
            </IconTooltip>
            <IconTooltip label="翻转名片">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="翻转选中名片"
                disabled={!selectedCard}
                onClick={() => {
                  if (selectedCard) flip(selectedCard.id)
                }}
              >
                <Repeat2Icon aria-hidden="true" />
              </Button>
            </IconTooltip>
            <IconTooltip label="移除名片">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-destructive hover:text-destructive"
                aria-label="从名片墙移除"
                disabled={!selectedCard || selectedPending}
                onClick={() => setRemoveOpen(true)}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </IconTooltip>
          </div>
        ) : null}

        {orderedCards.length ? (
          orderedCards.map((card) => (
            <WallCard
              key={card.id}
              board={board}
              card={card}
              editing={editing}
              flipped={flippedIds.has(card.id)}
              pending={pendingCardIds.has(card.id)}
              selected={selectedCard?.id === card.id}
              onFlip={() => flip(card.id)}
              onSelect={() => setSelectedId(card.id)}
              onPlacementPreview={onPlacementPreview}
              onPlacementCommit={onPlacementCommit}
            />
          ))
        ) : (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            名片墙还是空的
          </p>
        )}

        <div className="pointer-events-none absolute right-3 bottom-3 z-1001 flex items-center gap-1.5 border bg-background/90 px-2 py-1 text-xs text-muted-foreground">
          <Repeat2Icon className="size-3.5" aria-hidden="true" />
          {cards.length} 张名片
        </div>
      </div>

      <AlertDialog open={editing && removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="text-destructive">
              <Trash2Icon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>从名片墙移除？</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedCard
                ? `“${selectedCard.displayName}”会从当前事务所移除，名片本身仍会保留。`
                : "名片会从当前事务所移除，名片本身仍会保留。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={selectedPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!selectedCard || selectedPending}
              onClick={() => {
                if (!selectedCard) return
                setRemoveOpen(false)
                onRemove?.(selectedCard)
              }}
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}
